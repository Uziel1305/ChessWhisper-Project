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

// Only white's clock expiring is covered here — that's this ticket's scope.
// Black's side is a separate case, not yet covered.
describe('Game — flag detection', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('when a clock reaches zero, the game ends with the opponent as winner, and game.end reaches both sockets', () => {
    jest.useFakeTimers();
    const game = new Game(1000);

    const whiteSocket = jest.fn();
    const blackSocket = jest.fn();
    game.on('game.end', whiteSocket);
    game.on('game.end', blackSocket);

    game.start();
    jest.advanceTimersByTime(1000);

    const expected = { winner: 'black', reason: 'timeout' };
    expect(whiteSocket).toHaveBeenCalledWith(expected);
    expect(blackSocket).toHaveBeenCalledWith(expected);
  });
});
