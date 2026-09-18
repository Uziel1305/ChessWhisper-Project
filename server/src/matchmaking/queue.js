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
// A waiter's acceptable window grows the longer they've sat here; a fresh
// join always starts from this base, whichever side of the comparison it's on.
const BASE_RATING_WINDOW = 100;
const RATING_WINDOW_STEP = 50;
const RATING_WINDOW_STEP_MS = 10000;



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

// How wide a net a waiter will accept right now, given how long they've been
// sitting here. Grows in whole RATING_WINDOW_STEP-point jumps every
// RATING_WINDOW_STEP_MS, not continuously — a player waiting 19s has the same
// window as one waiting 10s, and gets no benefit of the doubt in between.
function windowFor(joinedAt) {
    const elapsedSteps = Math.floor((Date.now() - joinedAt) / RATING_WINDOW_STEP_MS);
    return BASE_RATING_WINDOW + RATING_WINDOW_STEP * elapsedSteps;
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
//
// rating travels in as plain data, read by the caller (hub.js) before this is
// called.
function join({ userId, mode, timeControl, rating }) {
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

    // Oldest qualifying waiter first, not closest-rating: findIndex scans from
    // the front of the array, which is join order (push adds to the end), so
    // the first entry within the window is also the one who has waited
    // longest among those eligible. An ineligible waiter ahead of an eligible
    // one is skipped in place rather than removed — they are still waiting
    // for someone else.
    //
    // The window checked is the *waiting* candidate's — theirs is the one
    // that's had time to widen. The newcomer just arrived, so judging by
    // their own (zero) wait would mean nobody's wait time ever mattered.
    const index = players.findIndex(
        (candidate) => Math.abs(candidate.rating - rating) <= windowFor(candidate.joinedAt)
    );

    if (index !== -1) {
        const [opponent] = players.splice(index, 1);
        if (players.length === 0) waiting.delete(key);
        return { mode, timeControl, players: [opponent, { userId, rating }] };
    }

    players.push({ userId, rating, joinedAt: Date.now() });
    waiting.set(key, players);
    return null;
}

// Test seam: module state is a singleton, so a suite needs a way to start clean.
function clear() {
    waiting.clear();
}

module.exports = { join, leave, clear, InvalidQueueRequestError, MODES, TIME_CONTROLS };


