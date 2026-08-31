const Game = require('../src/game/Game');

describe('Game — time control', () => {
  it('a 3-minute game starts both clocks at 180000', () => {
    const game = new Game(180000);
    expect(game.clocks.white.remainingMs()).toBe(180000);
    expect(game.clocks.black.remainingMs()).toBe(180000);
  });

  it('a 10-minute game starts both clocks at 600000', () => {
    const game = new Game(600000);
    expect(game.clocks.white.remainingMs()).toBe(600000);
    expect(game.clocks.black.remainingMs()).toBe(600000);
  });
});
