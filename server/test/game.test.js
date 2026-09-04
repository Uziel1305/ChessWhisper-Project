const Game = require('../src/game/Game');

describe('Game', () => {
    it('exposes legal moves as UCI strings from the starting position', () => {
        const game = new Game();
        const moves = game.legalMoves();

        expect(moves).toHaveLength(20);
        expect(moves).toContain('e2e4');
    });

    it('yields four promotion entries sharing the same from/to squares', () => {
        // A white pawn one square from promoting, nothing else in the way.
        const game = new Game('8/4P3/8/8/8/8/8/K6k w - - 0 1');
        const promotions = game.legalMoves().filter((m) => m.startsWith('e7e8'));

        // The four entries this test exists to pin: BoardView's rule is that
        // four moves sharing a from/to square is what triggers the promotion
        // picker, so the exact set matters, not just the count.
        expect(promotions.sort()).toEqual(['e7e8b', 'e7e8n', 'e7e8q', 'e7e8r']);
    });

    // CW-67's third case. Unlike checkmate, the shortest stalemate from the
    // opening is about nineteen half-moves, so this is constructed rather than
    // played — the same reason the promotion test above uses a FEN.
    it('detects stalemate as distinct from checkmate', () => {
        // Black king on h8, white queen f7, white king g6, black to move.
        // Every square the king could go to is covered, and h8 itself is not
        // attacked — no legal move, but not in check.
        const game = new Game('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1');

        expect(game.legalMoves()).toHaveLength(0);
        expect(game.isStalemate()).toBe(true);
        // The distinction that decides the result: a stalemate is a draw, a
        // checkmate is a loss for the side to move. Both look like "no legal
        // moves" from the outside.
        expect(game.isCheckmate()).toBe(false);
    });

    it('detects a draw by insufficient material', () => {
        // Bare kings — neither side can ever mate.
        const game = new Game('8/8/8/4k3/8/8/4K3/8 w - - 0 1');

        expect(game.isDraw()).toBe(true);
        expect(game.isStalemate()).toBe(false);
    });

    it('detects a draw by the fifty-move rule', () => {
        // The halfmove clock is field 5 of a FEN, so the position can be
        // constructed one move short of the rule rather than played there.
        const game = new Game('7k/8/8/8/8/8/8/R6K w - - 99 100');

        expect(game.isDraw()).toBe(false);
        game.move('a1a8');
        expect(game.isDraw()).toBe(true);
    });

    it('detects a draw by threefold repetition', () => {
        const game = new Game();
        // The starting position recurs after each pair of knight round trips:
        // once at the start, again after four half-moves, a third time after
        // eight. chess.js counts positions, so a FEN alone cannot express this.
        for (const uci of ['g1f3', 'g8f6', 'f3g1', 'f6g8',
                           'g1f3', 'g8f6', 'f3g1', 'f6g8']) {
            expect(game.move(uci)).not.toBeNull();
        }

        expect(game.isThreefoldRepetition()).toBe(true);
    });



})