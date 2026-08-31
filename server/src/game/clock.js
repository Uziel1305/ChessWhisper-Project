// Single-sided, turn-agnostic clock: it only knows running/paused, nothing about
// whose move it is. Turn ownership lives in Game.js, which calls start()/pause()
// on the correct side's Clock when a move commits.
//
// Timestamp-based per the project's capacity decision: remaining time is computed
// from wall-clock elapsed time, not decremented on a tick. start() schedules a
// single setTimeout for the exact remaining duration, so the flag fires itself at
// the deadline instead of anything polling for it.
class Clock {
  constructor(durationMs, onExpire) {
    this.remaining = durationMs;
    this.running = false;
    this.turnStartedAt = null;
    this.expired = false;
    this.onExpire = onExpire;
    this.timeoutHandle = null;
  }

  start() {
    if (this.running || this.expired) return;
    this.running = true;
    this.turnStartedAt = Date.now();
    this.timeoutHandle = setTimeout(() => this._expire(), this.remaining);
  }

  pause() {
    if (!this.running) return;
    this.remaining = this.remainingMs();
    this.running = false;
    clearTimeout(this.timeoutHandle);
    this.timeoutHandle = null;
  }

  remainingMs() {
    if (!this.running) return this.remaining;
    return Math.max(0, this.remaining - (Date.now() - this.turnStartedAt));
  }

  isExpired() {
    return this.expired;
  }

  _expire() {
    this.expired = true;
    this.running = false;
    this.remaining = 0;
    if (this.onExpire) this.onExpire();
  }
}

module.exports = Clock;
