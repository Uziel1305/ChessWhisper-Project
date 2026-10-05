const queue = require('../matchmaking/queue');
const GameManager = require('./GameManager');
const engineClient = require('../engine/engineClient');
const engineUserRepo = require('../db/repositories/engineUser.repo');

// Games against the engine: starting one, and playing the engine's side. The
// engine is an ordinary participant — its moves go through GameManager.applyMove
// under the engine user's id, so they are validated, stored, broadcast and
// checked for game end exactly like a player's. Nothing here decides a result
// except the forfeit below.

// The modes an engine game may be played in. A subset of queue.MODES, which is
// the vocabulary itself. Classic only for now: assist features against the
// engine cost extra engine calls and are deliberately not offered yet.
const ENGINE_MODES = new Set(['classic']);

// The engine's thinking time per move — the same budget as one evaluation, so
// an engine move costs the pool exactly one evaluation-sized slot.
const ENGINE_MOVE_BUDGET_MS = 800;

// If no legal move has been committed this long after the engine's turn began,
// the engine forfeits. A frozen board is worse than an unrated win.
let moveDeadlineMs = 15000;
// Pause between attempts. While the breaker is open these fail at once without
// touching the network, so retrying this often costs nothing.
let retryMs = 2000;

// userId (string) -> the gameId of their engine game. Stale entries are harmless:
// a game that has ended is no longer in GameManager, and that is what is checked.
const gameByUser = new Map();
// Users whose engine.start is between its check and the game existing, so two
// starts sent back to back cannot both pass the one-game-per-user check.
const starting = new Set();
// Games whose engine is thinking, so one engine turn never runs twice at once.
const thinking = new Set();

// Cached once found. A missing row is not cached, so it is looked up again.
let engineUser = null;

async function loadEngineUser() {
    if (!engineUser) engineUser = (await engineUserRepo.findEngineUser()) ?? null;
    return engineUser;
}

function reject(userId, error, message) {
    // Required here, not at module scope: hub.js requires this file.
    const hub = require('../ws/hub');
    hub.sendToUser(userId, { type: 'queue.rejected', error, message });
}

// engine.start. Validated as strictly as queue.join, and answered the same way:
// match.found on success, queue.rejected otherwise. Resolves once the game exists
// and, if the engine has White, once its first move is in.
async function start(userId, { mode, timeControl } = {}) {
    if (!queue.MODES.has(mode)) {
        return reject(userId, 'unknown_mode', `unknown mode: ${mode}`);
    }
    if (!ENGINE_MODES.has(mode)) {
        return reject(userId, 'mode_not_offered', `mode ${mode} is not offered against the engine`);
    }
    if (!queue.TIME_CONTROLS.has(timeControl)) {
        return reject(userId, 'unknown_time_control', `unsupported time control: ${timeControl}`);
    }

    // One live engine game per user, so one client cannot fill the engine pool.
    const current = gameByUser.get(userId);
    if (starting.has(userId) || (current && GameManager.get(current))) {
        return reject(userId, 'already_playing', 'you already have a game against the engine');
    }
    starting.add(userId);

    let game;
    try {
        // A player waiting for a human opponent who starts an engine game instead
        // must not later be matched into a second game.
        queue.leave(userId);

        const engine = await loadEngineUser();
        if (!engine) {
            console.error('engine.start: no is_engine user in users');
            return reject(userId, 'engine_unavailable', 'the engine is not available');
        }

        try {
            game = await GameManager.createEngineGame({ userId, engineUser: engine, mode, timeControl });
        } catch (err) {
            console.error('createEngineGame failed:', err);
            return reject(userId, 'game_not_created', 'could not start the game, please try again');
        }
        gameByUser.set(userId, game.id);
    } finally {
        starting.delete(userId);
    }

    // The engine has White: it moves first.
    return think(game);
}

// Called by the hub after every committed player move. For a game that is not
// an engine game, or no longer live, it returns undefined at once.
function afterHumanMove(gameId) {
    const game = GameManager.get(gameId);
    if (!game || !game.engineColor) return undefined;
    return think(game);
}

function engineUserIdOf(game) {
    return game.engineColor === 'white' ? game.whiteUserId : game.blackUserId;
}

// Whether the engine should be moving in this game right now.
function enginesTurn(game) {
    return !game.ended
        && GameManager.get(game.id) === game
        && (game.position.turn() === 'w') === (game.engineColor === 'white');
}

// Plays the engine's turn: ask, commit, retry on failure, forfeit at the
// deadline. Never rejects — every failure is logged here.
async function think(game) {
    if (thinking.has(game.id)) return;
    thinking.add(game.id);
    try {
        const deadline = Date.now() + moveDeadlineMs;
        for (;;) {
            if (!enginesTurn(game)) return;
            if (await tryMove(game)) return;
            if (Date.now() >= deadline) {
                await forfeit(game);
                return;
            }
            await new Promise((resolve) => setTimeout(resolve, retryMs));
        }
    } catch (err) {
        console.error('engine turn failed for game', game.id, ':', err);
    } finally {
        thinking.delete(game.id);
    }
}

// One attempt. True when the turn is over — the move committed, or the game no
// longer needs one — false when it should be retried.
async function tryMove(game) {
    let bestMove;
    try {
        ({ bestMove } = await engineClient.chooseMove(game.position.fen(), ENGINE_MOVE_BUDGET_MS));
    } catch (err) {
        console.error('engine move failed for game', game.id, ':', err.message);
        return false;
    }
    if (!bestMove) {
        console.error('engine returned no move for game', game.id);
        return false;
    }

    // The player may have resigned, disconnected or flagged while it thought.
    if (!enginesTurn(game)) return true;

    // The same path as a player's move. null means it was refused — applyMove
    // has already logged why — so it counts as a failed attempt.
    const committed = await GameManager.applyMove({
        gameId: game.id,
        userId: engineUserIdOf(game),
        uci: bestMove,
    });
    return committed !== null;
}

// The engine loses; the player wins. Unrated, like every engine game.
function forfeit(game) {
    return GameManager.endGame(game, {
        result: game.engineColor === 'white' ? '0-1' : '1-0',
        reason: 'engine_failed',
    });
}

// Test hooks: the real deadline is 15s, too long to wait out in a test.
function _setTiming({ deadlineMs, retryIntervalMs }) {
    moveDeadlineMs = deadlineMs;
    retryMs = retryIntervalMs;
}

module.exports = {
    start,
    afterHumanMove,
    ENGINE_MODES,
    ENGINE_MOVE_BUDGET_MS,
    _setTiming,
};
