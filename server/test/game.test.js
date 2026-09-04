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



})