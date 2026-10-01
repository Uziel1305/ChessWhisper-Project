const crypto = require('crypto');
const gamesRepo = require('../db/repositories/games.repo');
const movesRepo = require('../db/repositories/moves.repo');
const usersRepo = require('../db/repositories/users.repo');
const ratingsRepo = require('../db/repositories/ratings.repo');
const feedbackRepo = require('../db/repositories/feedback.repo');
const { withTransaction } = require('../db/transaction');
const elo = require('../rating/elo');
const Game = require('./Game');
const Clock = require('./clock');
const engineClient = require('../engine/engineClient');
const { classifyMove } = require('./classification');

// The modes whose games ask the engine for anything. Opt-in: classic,
// retraction and any mode added later cost zero engine calls until they are
// listed here, and the engine is the scarce resource (CLAUDE.md, "Engine
// capacity"). Deliberately separate from queue.js's MODES, which is the set a
// player may *request*. retraction is absent on purpose: its verdict would gate
// a timed undo window, which is a different, latency-critical design from the
// fire-and-forget evaluation below.
const EVALUATED_MODES = new Set(['eval', 'feedback']);

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
//               evals:         Map{ ply → cp }    ← RAM only. White-perspective
//                              centipawns from the engine, one per evaluated ply.
//                              Filled as results arrive, in any order.
//               mates:         Map{ ply → mateIn | null }  ← RAM only. Written
//                              beside evals, so the two always cover the same plies.
//               classified:    Set{ ply }         ← RAM only. Plies whose verdict
//                              has been sent, so none is ever sent twice.
//               ended:         false               ← RAM only. Set once by
//                              endGame, so a second call on a reference a
//                              caller already held (see endGame) is a no-op.
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
        mode: game.mode,
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
    }).catch((err) => {
        console.error('endGame failed for timeout on game', gameId, ':', err);
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
        evals: new Map(),
        mates: new Map(),
        classified: new Set(),
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
    // Captured now, synchronously, for the evaluation below: game.ply may have
    // moved on by the time the insert's await returns.
    const ply = game.ply;

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

    // The one place the engine is called: once per committed half-move, and for
    // the move that ends the game too — a mating move is still a committed
    // half-move. Placed before the outcome check below so it fires however the
    // game ends. Not awaited, and its promise is not returned: move.committed
    // has already gone out, and nothing after this line may wait on the engine.
    if (EVALUATED_MODES.has(game.mode)) {
        evaluatePly(game, ply, fen, mover);
    }

    // After move.committed, never before: the clients need the final position
    // rendered before they are told the game is over, and the test asserts that
    // order — move.committed then game.end, on the same socket.
    const outcome = game.position.outcome();
    if (outcome) {
        await endGame(game, outcome);
    }

    return event;
}


// Odd plies are white's, even plies black's — ply 1 is white's first move.
function moverOf(ply) {
    return ply % 2 === 1 ? 'white' : 'black';
}

// Asks the engine about the position a move produced and publishes whatever the
// answer is good for. Closes over `game` rather than looking it up in `games`:
// endGame removes the game from that map synchronously, so for the final move of
// a game the answer arrives after the lookup would already fail — and it should
// still be stored and sent (sendToUser is a no-op for a socket that is gone).
//
// moverUserId is applyMove's `mover`, captured there synchronously at commit
// time — never re-derived from game state once this resolves, since by then the
// turn may already belong to the opponent.
//
// async, so the engineClient call runs synchronously up to its first await and
// every failure lands in the catch below; an unhandled rejection here would
// otherwise take down the process over a missing evaluation.
async function evaluatePly(game, ply, fen, moverUserId) {
    try {
        // Both are kept, because classification compares them ply to ply: cp
        // always, and mateIn (signed, white-perspective, null if no forced
        // mate) when both neighbours are a mate for the same side, where every
        // cp is the same clamped 10000. Set together, so a ply never has one
        // without the other.
        const { cp, mateIn } = await engineClient.evaluate(fen);
        game.evals.set(ply, cp);
        game.mates.set(ply, mateIn);
        publishEvaluation(game, ply, moverUserId, mateIn);
    } catch (err) {
        // A failed evaluation is a gap, not an error the game can act on: the
        // move is committed and delivered either way. That ply, and the one
        // after it (which needs it as its "before"), simply get no verdict.
        console.error('evaluation failed for ply', ply, 'of game', game.id, ':', err);
    }
}

// One stored result, two consumers. What is *sent* depends on the game's mode,
// not on what has been computed: a player holding an assist their opponent lacks
// has an unfair advantage (CLAUDE.md, `mode`), so an eval game never carries a
// verdict and a feedback game never carries the bar value.
function publishEvaluation(game, ply, moverUserId, mateIn) {
    const hub = require('../ws/hub');

    if (game.mode === 'eval') {
        // Both players see the same bar, and it needs no neighbouring result, so
        // it goes out the moment it arrives. mateIn is added only when there is
        // one, so an ordinary update keeps its plain { type, ply, evalCp } shape.
        const event = { type: 'eval.update', ply, evalCp: game.evals.get(ply) };
        if (mateIn !== null) event.mateIn = mateIn;
        hub.sendToUser(game.whiteUserId, event);
        hub.sendToUser(game.blackUserId, event);
    }

    if (game.mode === 'feedback') {
        // Results arrive in any order. This ply's answer can be the missing half
        // of its own verdict (with ply - 1, mover moverUserId) or of the next
        // one's (with ply + 1, mover the *other* participant — chess alternates,
        // and a game only ever has these two), so both are tried; classifyPly
        // does nothing until both halves exist.
        classifyPly(game, ply, moverUserId);
        classifyPly(game, ply + 1, opponentOf(game, moverUserId));
    }
}

// The other of a game's two fixed participants. Used only to name who played
// the *next* ply given who played this one — never to guess whose turn it is
// right now, which is a different question this file is careful not to ask
// asynchronously (see evaluatePly's comment).
function opponentOf(game, userId) {
    return String(userId) === String(game.whiteUserId) ? game.blackUserId : game.whiteUserId;
}

// A move's verdict needs the evaluation before it and after it. Ply 1 never has
// a "before" — no evaluation exists for the start position, and asking for one
// would be an engine call belonging to no committed half-move — so white's first
// move is never classified.
function classifyPly(game, ply, moverUserId) {
    const hub = require('../ws/hub');

    if (ply < 2 || game.classified.has(ply)) return;
    const evalBefore = game.evals.get(ply - 1);
    const evalAfter = game.evals.get(ply);
    if (evalBefore === undefined || evalAfter === undefined) return;

    game.classified.add(ply);
    // moverOf(ply) is ply's colour, needed only for cpLoss's white/black-
    // perspective math — a different question from who to send to. That's
    // moverUserId, captured at this move's own commit and threaded down from
    // there, never re-derived here. Feedback is private: only the player who
    // made the move hears it.
    const { classification, cpLoss: loss, lostAdvantage } = classifyMove({
        evalBefore,
        evalAfter,
        mateBefore: game.mates.get(ply - 1),
        mateAfter: game.mates.get(ply),
        mover: moverOf(ply),
    });
    // lostAdvantage is added only when true, so an ordinary verdict keeps its
    // plain { type, ply, classification, cpLoss } shape — the same convention
    // eval.update follows for mateIn.
    const event = { type: 'move.feedback', ply, classification, cpLoss: loss };
    if (lostAdvantage) event.lostAdvantage = true;
    hub.sendToUser(moverUserId, event);

    // Not awaited: the verdict has already been sent, and a slow or failed
    // write must never delay or drop it — the same reasoning evaluatePly
    // already applies to the engine call itself.
    feedbackRepo
        .insert({ gameId: game.id, ply, ownerUserId: moverUserId, classification, cpLoss: loss })
        .catch((err) => {
            console.error('feedback insert failed for ply', ply, 'of game', game.id, ':', err);
        });
}


// White's score for elo.js's `score` parameter — the only one of the three
// PGN results elo.js needs translated, since it always takes white's
// perspective as "A" and derives black's as 1 - score.
function scoreForWhite(result) {
    if (result === '1-0') return 1;
    if (result === '0-1') return 0;
    return 0.5;
}

// The single exit for every ending — checkmate, draw, resignation, and the
// timeout Tamir's CW-63 will call this with. Takes the verdict rather than
// working it out, because only two of the four come from the position.
async function endGame(game, { result, reason }) {
    const hub = require('../ws/hub');

    // applyMove holds its own reference to `game` across its
    // `await movesRepo.insert(...)` gap (above), and removing a game from the
    // `games` map below does not invalidate a reference a caller already
    // holds. If a disconnect/resign/timeout for the same game reaches this
    // function first, applyMove still calls endGame again on that same object
    // once its await resolves. This guard, checked-and-set synchronously
    // before anything else runs, makes the second call a no-op instead of a
    // second Elo application and a duplicate rating_history row: whichever
    // call reaches this line first always finishes reading and setting it
    // before either call's next await, since Node never interleaves two
    // synchronous stretches of code.
    if (game.ended) return null;
    game.ended = true;

    // Stops both clocks' pending flag timers immediately — otherwise a clock from
    // a game that just ended by checkmate/resign would still fire its setTimeout
    // later into onFlag's no-op guard (harmless, but needless).
    game.clocks.white.pause();
    game.clocks.black.pause();
    // Removed synchronously, before either await below. A move arriving during
    // them finds no game and is dropped by applyMove's existing guard — which is
    // why Game.move needs no is-it-over check, and why this covers resignation
    // and timeout as well as the position-based endings.
    remove(game.id);

    // Rating deltas need each player's *current* rating (match.found's
    // snapshot is stale by now — either player may have finished other games
    // since) and how many rated games they've each already finished, for
    // elo.js's K-factor. This is the one unavoidable await before the
    // broadcast below: unlike result/reason, a rating change cannot be worked
    // out from the position, it has to be read first. countRatedGames is
    // called before gamesRepo.finish() below records this game, so it
    // correctly counts only games finished *before* this one.
    const [whiteUser, blackUser, whiteGamesPlayed, blackGamesPlayed] = await Promise.all([
        usersRepo.findById(game.whiteUserId),
        usersRepo.findById(game.blackUserId),
        ratingsRepo.countRatedGames(game.whiteUserId),
        ratingsRepo.countRatedGames(game.blackUserId),
    ]);

    const { deltaA: whiteDelta, deltaB: blackDelta } = elo.computeElo({
        ratingA: whiteUser.rating,
        ratingB: blackUser.rating,
        score: scoreForWhite(result),
        gamesPlayedA: whiteGamesPlayed,
        gamesPlayedB: blackGamesPlayed,
    });
    const whiteNewRating = whiteUser.rating + whiteDelta;
    const blackNewRating = blackUser.rating + blackDelta;

    // Persisted before broadcasting, the same ordering applyMove already uses
    // for move.committed. This used to be reversed on purpose — broadcast
    // first, since an ending "continues into nothing" so a failed write looked
    // harmless next to two players stranded on a dead board. In practice that
    // ordering let clients see (and callers observe, including tests awaiting
    // this event) a result and rating change before the database had actually
    // committed either, which is exactly the window that produced this
    // function's abandon/disconnect races: a game or user row deleted, or the
    // connection pool closed, in the gap between "clients were told" and
    // "the write actually ran". Persisting first closes that gap — by the
    // time either player hears game.end, the row updates and the
    // rating_history insert are already durable.
    //
    // One transaction, so the five writes land together or not at all. They
    // used to be five independent queries on the shared pool: when one failed,
    // the rest had already committed, leaving e.g. a finished game with ratings
    // applied and no history row (gameManager.test.js reproduces exactly that).
    // Sequential rather than Promise.all because a single connection runs one
    // query at a time anyway. Every write takes `client`, never the pool — see
    // withTransaction for why.
    await withTransaction(async (client) => {
        await gamesRepo.finish({ id: game.id, result, reason }, client);
        await usersRepo.updateRating(game.whiteUserId, whiteNewRating, client);
        await usersRepo.updateRating(game.blackUserId, blackNewRating, client);
        await ratingsRepo.recordRatingChange({
            gameId: game.id, userId: game.whiteUserId,
            ratingBefore: whiteUser.rating, ratingAfter: whiteNewRating,
        }, client);
        await ratingsRepo.recordRatingChange({
            gameId: game.id, userId: game.blackUserId,
            ratingBefore: blackUser.rating, ratingAfter: blackNewRating,
        }, client);
    });

    // Each side gets its own payload now, not a shared object like before
    // CW-134: the rating delta genuinely differs between the two players, so
    // there is no longer a single event that is equally true for both.
    const whiteEvent = {
        type: 'game.end', result, reason,
        newRating: whiteNewRating, ratingDelta: whiteDelta,
    };
    const blackEvent = {
        type: 'game.end', result, reason,
        newRating: blackNewRating, ratingDelta: blackDelta,
    };
    hub.sendToUser(game.whiteUserId, whiteEvent);
    hub.sendToUser(game.blackUserId, blackEvent);

    return { white: whiteEvent, black: blackEvent };
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

// Called when a user's socket closes while they were in a live game - app
// closed normally, crashed, force-stopped, or lost network. Not a deliberate
// in-app action the way resign() is, hence the distinct reason. Scans games
// rather than keeping a userId index: this only runs on the rare disconnect
// event, and at the project's ~100-concurrent-game target a scan over the
// live games costs nothing worth indexing for.
async function abandon(userId) {
    const leaver = String(userId);
    for (const game of games.values()) {
        const isWhite = leaver === String(game.whiteUserId);
        const isBlack = leaver === String(game.blackUserId);
        if (isWhite || isBlack) {
            return endGame(game, {
                result: isWhite ? '0-1' : '1-0',
                reason: 'abandoned',
            });
        }
    }
    return null;
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

module.exports = { createGame, applyMove, resign, abandon, endGame, get, remove, activeCount };
