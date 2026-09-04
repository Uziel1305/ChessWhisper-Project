const crypto = require('crypto');
const gamesRepo = require('../db/repositories/games.repo');
const movesRepo = require('../db/repositories/moves.repo');
const usersRepo = require('../db/repositories/users.repo');
const Game = require('./Game');



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
        // Null until CW-61 wires clock.js in. The field is here from the first
        // version so that filling it never restructures the payload — the
        // Android client has been parsing it since the CW-36 stub.
        clocks: null,
    };
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
    };
    games.set(id, game);

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
        clocks: null,
    };
    hub.sendToUser(game.whiteUserId, event);
    hub.sendToUser(game.blackUserId, event);

    return event;
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

module.exports = { createGame, applyMove, get, remove, activeCount };
