const crypto = require('crypto');
const gamesRepo = require('../db/repositories/games.repo');
const movesRepo = require('../db/repositories/moves.repo');
const usersRepo = require('../db/repositories/users.repo');
const Game = require('./Game');
const Clock = require('./clock');



// gameId -> the live game. The database rows are the durable record; this is
// what moves are actually applied to. /api/admin/stats reads active games here.
// gameId ──▶ {
//               id:            '4f2a...'      (UUID, same as the key)
//               mode:          'classic'
//               timeControlMs: 600000
//               whiteUserId:   '7'            ← string
//               blackUserId:   '12'           ← string
//               position:      Game{ chess.js }   ← RAM only
//               ply:           0                  ← RAM only
//            }
const games = new Map();


// Takes the live game rather than a handful of its fields: the only things that
// genuinely differ between the two players are their colour and who they face,
// which is now exactly what the signature says. fen and legalMoves come from
// the position for the same reason move.committed does — one source of truth.
function matchFound(game, color, opponent) {
    return {
        type: 'match.found',
        gameId: game.id,
        color,
        opponent: { username: opponent.username, rating: opponent.rating },
        fen: game.position.fen(),
        legalMoves: game.position.legalMoves(),
        timeControlMs: game.timeControlMs,
        clocks: {
            white: game.clocks.white.remainingMs(),
            black: game.clocks.black.remainingMs(),
        },
    };
}

// A clock's onExpire fires long after creation, so it looks the game up fresh
// rather than closing over it — the game may already have ended some other way
// (checkmate, resignation) by the time this fires, which is not a bug.
function onFlag(gameId, expiredColor) {
    const game = games.get(gameId);
    if (!game) return;
    endGame(game, {
        result: expiredColor === 'white' ? '0-1' : '1-0',
        reason: 'timeout',
    });
}




// Takes the pair the queue produced and turns it into a real game: colours,
// a row, a live entry, and one match.found to each player.
async function createGame({ mode, timeControl, players }) {
    // Required inside the function, not at module scope. hub.js requires this
    // file and this file requires hub.js; at load time hub.js has not yet
    // assigned its module.exports, so a top-level require here would capture an
    // empty object that never gets filled in.
    const hub = require('../ws/hub');
    const [first, second] = players;

    // Coin flip. Nothing about the pair's order should decide colour — the
    // queue returns longest-waiter-first, which would otherwise always be white.
    const whiteFirst = Math.random() < 0.5;
    const whiteUserId = whiteFirst ? first.userId : second.userId;
    const blackUserId = whiteFirst ? second.userId : first.userId;

    const id = crypto.randomUUID();

    // Awaited before anything is announced: a failed insert must not leave two
    // players believing they are in a game that was never recorded.
    await gamesRepo.insert({
        id,
        whiteUserId,
        blackUserId,
        mode,
        timeControlMs: timeControl,
    });

    // The queue only carries user ids, so the display names come from here.
    const [whiteUser, blackUser] = await Promise.all([
        usersRepo.findById(whiteUserId),
        usersRepo.findById(blackUserId),
    ]);

    // Two raw Clock instances, not wrapped in a Game-like class — GameManager
    // already owns turn tracking (via position.turn()) and the game's lifecycle,
    // so a clock pair is all that's needed here.
    const clocks = {
        white: new Clock(timeControl, () => onFlag(id, 'white')),
        black: new Clock(timeControl, () => onFlag(id, 'black')),
    };

    const game = {
        id,
        mode,
        timeControlMs: timeControl,
        whiteUserId,
        blackUserId,
        // The chess.js position, wrapped. Every move is validated against this
        // rather than against anything read back from the database.
        position: new Game(),
        // Half-moves committed so far. Kept here rather than derived, because
        // GameManager owns the game's lifecycle and is the only thing that
        // advances it — it moves in lockstep with position, below.
        ply: 0,
        clocks,
    };
    games.set(id, game);
    // White is to move as soon as the game exists.
    game.clocks.white.start();

    hub.sendToUser(whiteUserId, matchFound(game, 'white', blackUser));
    hub.sendToUser(blackUserId, matchFound(game, 'black', whiteUser));

    return game;
}


// Applies a move on behalf of a player and broadcasts it to both. Returns null
// and changes nothing if the move is not allowed: the server answers an invalid
// move with silence, so there is no error to build here — only a line to log.
async function applyMove({ gameId, userId, uci }) {
    const hub = require('../ws/hub');

    const game = games.get(gameId);
    if (!game) {
        // Reachable without a bug: a move can cross with the game ending.
        console.error('game.move for an unknown game:', gameId);
        return null;
    }

    const mover = String(userId);
    const isWhite = mover === String(game.whiteUserId);
    const isBlack = mover === String(game.blackUserId);
    if (!isWhite && !isBlack) {
        console.error('game.move from a non-participant:', mover, gameId);
        return null;
    }

    // chess.js validates a move against the board and has no idea who sent it.
    // This is the check it cannot make, and the one that stops a player moving
    // their opponent's pieces.
    if ((game.position.turn() === 'w') !== isWhite) {
        console.error('game.move out of turn:', mover, gameId);
        return null;
    }

    // Applied synchronously and before the insert is awaited. That ordering is
    // deliberate: a second move arriving during the await is then validated
    // against the already-advanced position instead of the stale one.
    const fen = game.position.move(uci);
    if (!fen) {
        console.error('game.move illegal:', uci, gameId);
        return null;
    }
    game.ply += 1;

    // Turn switch: pause whoever just moved, start whoever is now to move — the
    // same synchronous point the position itself advances, for the same reason
    // (a second move arriving during the DB await must see the already-switched
    // clocks, not the stale pair).
    if (isWhite) {
        game.clocks.white.pause();
        game.clocks.black.start();
    } else {
        game.clocks.black.pause();
        game.clocks.white.start();
    }

    // Awaited before broadcasting: a move both players can see must exist in
    // the record. One indexed insert on local Postgres is 1-2ms against CW-57's
    // 150ms budget. Known cost: if this throws, the position has already
    // advanced and the game continues with a gap in its stored move list.
    await movesRepo.insert({ gameId, ply: game.ply, uci });

    const event = {
        type: 'move.committed',
        uci,
        fen,
        legalMoves: game.position.legalMoves(),
        clocks: {
            white: game.clocks.white.remainingMs(),
            black: game.clocks.black.remainingMs(),
        },
    };
    hub.sendToUser(game.whiteUserId, event);
    hub.sendToUser(game.blackUserId, event);

    // After move.committed, never before: the clients need the final position
    // rendered before they are told the game is over, and the test asserts that
    // order — move.committed then game.end, on the same socket.
    const outcome = game.position.outcome();
    if (outcome) {
        await endGame(game, outcome);
    }

    return event;
}


// The single exit for every ending — checkmate, draw, resignation, and the
// timeout Tamir's CW-63 will call this with. Takes the verdict rather than
// working it out, because only two of the four come from the position.
async function endGame(game, { result, reason }) {
    const hub = require('../ws/hub');

    // Removed synchronously, before either await below. A move arriving during
    // them finds no game and is dropped by applyMove's existing guard — which is
    // why Game.move needs no is-it-over check, and why this covers resignation
    // and timeout as well as the position-based endings.
    remove(game.id);
    // Stops both clocks' pending flag timers immediately — otherwise a clock from
    // a game that just ended by checkmate/resign would still fire its setTimeout
    // later into onFlag's no-op guard (harmless, but needless).
    game.clocks.white.pause();
    game.clocks.black.pause();

    // Broadcast before persisting, which is the opposite of applyMove — and the
    // difference is deliberate. A move that reaches both boards without reaching
    // the table leaves the game continuing from a state the record does not
    // have, and the divergence compounds. An ending continues into nothing. If
    // the write fails, the worst case is a games row left with a null result,
    // while the alternative is two players stranded on a dead board with no idea
    // why their moves stopped working.
    const event = { type: 'game.end', result, reason };
    hub.sendToUser(game.whiteUserId, event);
    hub.sendToUser(game.blackUserId, event);

    await gamesRepo.finish({ id: game.id, result, reason });

    return event;
}


// Resignation is not a move and not a property of the position, so it never
// touches Game — the resigner loses, whatever the board looks like.
async function resign({ gameId, userId }) {
    const game = games.get(gameId);
    if (!game) {
        console.error('game.resign for an unknown game:', gameId);
        return null;
    }

    const resigner = String(userId);
    const isWhite = resigner === String(game.whiteUserId);
    const isBlack = resigner === String(game.blackUserId);
    // Without this a stranger could end someone else's game, which is a worse
    // hole than the move equivalent: they cannot play your pieces, but they
    // could make you lose.
    if (!isWhite && !isBlack) {
        console.error('game.resign from a non-participant:', resigner, gameId);
        return null;
    }

    return endGame(game, {
        result: isWhite ? '0-1' : '1-0',
        reason: 'resign',
    });
}

function get(gameId) {
    return games.get(gameId);
}

// Called when a game ends, so finished games stop counting as live. CW-69 is
// what actually calls it.
function remove(gameId) {
    return games.delete(gameId);
}

function activeCount() {
    return games.size;
}

module.exports = { createGame, applyMove, resign, endGame, get, remove, activeCount };
