const { Chess } = require('chess.js');

// Wraps chess.js so nothing else on the server touches it directly. Holds the
// live position for one game, validates moves against it, and speaks UCI —
// the only move notation that crosses the wire.
//
// Deliberately knows nothing about gameId, players or sockets. Those belong to
// GameManager, the same way the queue knows nothing about games.

class Game {
    chess;
    
    // fen is optional and exists for tests. Reaching a promotable position
    // through real play takes twenty-odd legal moves; constructing one takes a
    // string. GameManager never passes it, so every real game starts standard.
    constructor(fen) {
        this.chess = fen ? new Chess(fen) : new Chess();
    }

    fen() {
        return this.chess.fen();
    }

    // UCI strings — 'e2e4', or 'e7e8q' for a promotion. chess.js already emits
    // exactly this as `lan`, so there is no string building here to get wrong.
    legalMoves() {
        return this.chess.moves({ verbose: true }).map((m) => m.lan);
    }

    // 'w' or 'b'. GameManager compares this against whoever sent the move —
    // the one check chess.js cannot make, because it validates a move against
    // the board and has no idea who claimed to play it.
    turn() {
        return this.chess.turn();
    }

    // Applies the move and returns the resulting FEN, or null if it was not
    // legal. chess.js 1.x throws on an illegal move, but a throw is the wrong
    // shape here: an illegal move is an expected input, not an exceptional
    // event, and the caller's response is to do nothing either way.
    move(uci) {
        try {
            // move() takes SAN or {from, to, promotion}, never a UCI string.
            // uci[4] is undefined on a four-character move, which reads as
            // "no promotion" — so one expression handles both lengths. A
            // malformed uci throws inside here too and is rejected the same way.
            const result = this.chess.move({
                from: uci.slice(0, 2),
                to: uci.slice(2, 4),
                promotion: uci[4],
            });
            return result.after;
        } catch (err) {
            return null;
        }
    }
}
module.exports = Game;