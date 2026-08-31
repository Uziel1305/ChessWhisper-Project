const Clock = require('../src/game/clock');

// Clock is deliberately single-sided and turn-agnostic: it only knows
// running/paused, nothing about whose move it is. "Only the player to move
// ticks" becomes true once Game.js calls start()/pause() on turn changes —
// that's tested there, not here.

describe('Clock', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('reports the constructor duration before start() is ever called', () => {
    const clock = new Clock(600000);
    expect(clock.remainingMs()).toBe(600000);
  });

  it('decrements only while running, and freezes while paused', () => {
    jest.useFakeTimers();
    const clock = new Clock(180000);

    clock.start();
    jest.advanceTimersByTime(5000);
    expect(clock.remainingMs()).toBe(175000);

    clock.pause();
    jest.advanceTimersByTime(5000);
    expect(clock.remainingMs()).toBe(175000);

    clock.start();
    jest.advanceTimersByTime(1000);
    expect(clock.remainingMs()).toBe(174000);
  });

  it('reports expiry once it reaches zero, clamped at zero and never negative', () => {
    jest.useFakeTimers();
    const onExpire = jest.fn();
    const clock = new Clock(1000, onExpire);

    clock.start();
    jest.advanceTimersByTime(1500);

    expect(clock.isExpired()).toBe(true);
    expect(clock.remainingMs()).toBe(0);
    expect(onExpire).toHaveBeenCalledTimes(1);
  });
});
