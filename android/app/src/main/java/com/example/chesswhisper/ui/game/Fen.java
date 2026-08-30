package com.example.chesswhisper.ui.game;

// Decodes only the piece-placement field of a FEN string into an 8x8 grid for
// rendering. This is representation, not chess rules — the server remains the
// only place that computes legality, per the project's zero-rules-on-client principle.
final class Fen {

    private Fen() {
    }

    // board[0] is rank 8, board[7] is rank 1; within a row, index 0 is file a.
    // Empty squares hold '\0'.
    static char[][] parseBoard(String fen) {
        char[][] board = new char[8][8];
        String placement = fen.split(" ")[0];
        String[] ranks = placement.split("/");
        for (int row = 0; row < 8; row++) {
            int col = 0;
            for (char c : ranks[row].toCharArray()) {
                if (Character.isDigit(c)) {
                    col += c - '0';
                } else {
                    board[row][col] = c;
                    col++;
                }
            }
        }
        return board;
    }
}
