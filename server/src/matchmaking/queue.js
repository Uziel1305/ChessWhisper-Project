// The matchmaking waiting list. Deliberately free of sockets, events and the
// database: it decides who plays whom and nothing more, which is what lets it
// be reasoned about without a server running. GameManager owns colour
// assignment, game creation and announcing the match.

// Both halves of the key are validated rather than trusted. An unrecognised
// value would otherwise open a private waiting list nobody else can ever join,
// leaving the player queued forever with no error to explain it.
const MODES = new Set(['classic', 'eval', 'feedback', 'retraction']);
// 3, 5 and 10 minutes. The picker that offers these is deferred; the queue
// refuses anything outside the set regardless.
const TIME_CONTROLS = new Set([180000, 300000, 600000]);



class InvalidQueueRequestError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'InvalidQueueRequestError';
        // Travels to the client as queue.rejected { error, message }, matching
        // the envelope the REST routes already use.
        this.code = code;
    }
}

// key -> array of waiting players, oldest first.
const waiting = new Map();

function keyFor(mode, timeControl) {
    return `${mode}:${timeControl}`;
}


// Removes a player from whichever list holds them. Needed on queue.leave and,
// more importantly, when a socket closes: a disconnected player left in the
// list gets matched into a game with nobody listening on the other end.
function leave(userId) {
    for (const [key, players] of waiting){
        const index=players.findIndex((player)=> player.userId===userId);
        if(index===-1){
            continue;
        }
        players.splice(index,1);
        if(players.length===0){
            waiting.delete(key);
        }
        return true;
    }
    return false;
}


// Returns a pair when this player completes one, otherwise null. The pair is
// the caller's to turn into a game — the queue neither creates nor announces it.
function join({ userId, mode, timeControl }) {
    if (!MODES.has(mode)) {
        throw new InvalidQueueRequestError('unknown_mode', `unknown mode: ${mode}`);
    }
    if (!TIME_CONTROLS.has(timeControl)) {
        throw new InvalidQueueRequestError(
            'unknown_time_control',
            `unsupported time control: ${timeControl}`
        );
    }

    // A player already waiting must never be listed twice, or "the first two in
    // the key" pairs them against themselves.
    leave(userId);

    const key = keyFor(mode, timeControl);
    const players = waiting.get(key) ?? [];

    if (players.length > 0) {
        // Longest waiter first, so the pair carries the order they queued in.
        const opponent = players.shift();
        if (players.length === 0) waiting.delete(key);
        return { mode, timeControl, players: [opponent, { userId }] };
    }

    players.push({ userId });
    waiting.set(key, players);
    return null;
}

// Test seam: module state is a singleton, so a suite needs a way to start clean.
function clear() {
    waiting.clear();
}

module.exports = { join, leave, clear, InvalidQueueRequestError, MODES, TIME_CONTROLS };


