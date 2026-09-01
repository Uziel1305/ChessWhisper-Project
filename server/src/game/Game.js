const EventEmitter = require('events');
const Clock = require('./clock');

// Owns a single game's two clocks and turn ownership. Emits an in-process 'game.end'
// event on flag — GameManager (CW-61, blocked on CW-39) is what will later connect
// this to real socket.emit() calls once hub.js exists.
class Game extends EventEmitter {
  constructor(timeControlMs) {
    super();
    this.clocks = {
      white: new Clock(timeControlMs, () => this._onFlag('white')),
      black: new Clock(timeControlMs, () => this._onFlag('black')),
    };
  }

  start() {
    this.clocks.white.start();
  }

  _onFlag(color) {
    const winner = color === 'white' ? 'black' : 'white';
    this.emit('game.end', { winner, reason: 'timeout' });
  }
}

module.exports = Game;
