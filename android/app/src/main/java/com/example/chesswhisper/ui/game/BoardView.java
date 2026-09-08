package com.example.chesswhisper.ui.game;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.Rect;
import android.util.AttributeSet;
import android.view.MotionEvent;
import android.view.View;

import com.example.chesswhisper.R;

import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.stream.Collectors;

// Draws the board and pieces from a FEN + legalMoves pair, and turns taps into moves.
// Per the project's "legal-move hints come from the server" decision, this view never
// computes legality itself — it only filters the legalMoves array it was given.
public class BoardView extends View {

    // Starting position, used until setPosition() is called with real server data.
    private static final String DEFAULT_FEN =
            "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
    private static final List<String> DEFAULT_LEGAL_MOVES = List.of(
            "a2a3", "a2a4", "b2b3", "b2b4", "c2c3", "c2c4", "d2d3", "d2d4",
            "e2e3", "e2e4", "f2f3", "f2f4", "g2g3", "g2g4", "h2h3", "h2h4",
            "b1a3", "b1c3", "g1f3", "g1h3");

    public interface OnMoveListener {
        void onMoveSelected(String uci);

        void onPromotionNeeded(String from, String to, List<String> candidateUcis);
    }

    private char[][] board;
    private List<String> legalMoves;
    private String selectedSquare;
    private Set<String> highlightedTargets = new LinkedHashSet<>();
    private OnMoveListener listener;
    // True by default so the CW-49/50 manual-check path (no live game) is unaffected.
    // GameActivity (CW-56) turns this off the instant a move is sent and while it
    // isn't this player's turn.
    private boolean inputEnabled = true;
    // False by default so the CW-49/50 manual-check path (no live game) keeps its
    // white-at-bottom view. GameActivity sets this from match.found's color.
    private boolean flipped = false;

    private final Paint lightSquarePaint = new Paint();
    private final Paint darkSquarePaint = new Paint();
    private final Paint selectedSquarePaint = new Paint();
    private final Paint targetHighlightPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint piecePaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Rect textBounds = new Rect();

    public BoardView(Context context) {
        super(context);
        init(context);
    }

    public BoardView(Context context, AttributeSet attrs) {
        super(context, attrs);
        init(context);
    }

    private void init(Context context) {
        lightSquarePaint.setColor(context.getColor(R.color.board_light_square));
        darkSquarePaint.setColor(context.getColor(R.color.board_dark_square));
        selectedSquarePaint.setColor(context.getColor(R.color.board_selected_square));
        targetHighlightPaint.setColor(context.getColor(R.color.board_legal_target));
        piecePaint.setColor(context.getColor(R.color.black));
        piecePaint.setTextAlign(Paint.Align.CENTER);

        setPosition(DEFAULT_FEN, DEFAULT_LEGAL_MOVES);
    }

    public void setOnMoveListener(OnMoveListener listener) {
        this.listener = listener;
    }

    public void setInputEnabled(boolean inputEnabled) {
        this.inputEnabled = inputEnabled;
    }

    // Rotates the board 180 degrees so the local player's own pieces are always at
    // the bottom - h-file on the left and rank 1 at the top for black, matching the
    // standard "board flipped for black" convention.
    public void setFlipped(boolean flipped) {
        this.flipped = flipped;
        invalidate();
    }

    // Replaces the position wholesale — used both for the initial hardcoded position
    // and, later, whenever move.committed delivers a new one.
    public void setPosition(String fen, List<String> legalMoves) {
        this.board = Fen.parseBoard(fen);
        this.legalMoves = legalMoves;
        clearSelection();
        invalidate();
    }

    private void clearSelection() {
        selectedSquare = null;
        highlightedTargets = new LinkedHashSet<>();
    }

    @Override
    protected void onMeasure(int widthMeasureSpec, int heightMeasureSpec) {
        int size = Math.min(MeasureSpec.getSize(widthMeasureSpec), MeasureSpec.getSize(heightMeasureSpec));
        setMeasuredDimension(size, size);
    }

    @Override
    protected void onDraw(Canvas canvas) {
        super.onDraw(canvas);
        float squareSize = getWidth() / 8f;
        piecePaint.setTextSize(squareSize * 0.7f);

        for (int row = 0; row < 8; row++) {
            for (int col = 0; col < 8; col++) {
                int screenRow = flipped ? 7 - row : row;
                int screenCol = flipped ? 7 - col : col;
                float left = screenCol * squareSize;
                float top = screenRow * squareSize;
                boolean isLight = (row + col) % 2 == 0;
                canvas.drawRect(left, top, left + squareSize, top + squareSize,
                        isLight ? lightSquarePaint : darkSquarePaint);

                String square = squareName(row, col);
                if (square.equals(selectedSquare)) {
                    canvas.drawRect(left, top, left + squareSize, top + squareSize, selectedSquarePaint);
                } else if (highlightedTargets.contains(square)) {
                    canvas.drawCircle(left + squareSize / 2f, top + squareSize / 2f,
                            squareSize * 0.15f, targetHighlightPaint);
                }

                char piece = board[row][col];
                if (piece != 0) {
                    String glyph = glyphFor(piece);
                    // Baseline centering: drawText anchors on the text baseline, not the
                    // glyph's visual center, so this offsets by the measured text height.
                    piecePaint.getTextBounds(glyph, 0, glyph.length(), textBounds);
                    float x = left + squareSize / 2f;
                    float y = top + squareSize / 2f - textBounds.exactCenterY();
                    canvas.drawText(glyph, x, y, piecePaint);
                }
            }
        }
    }

    @Override
    public boolean onTouchEvent(MotionEvent event) {
        if (!inputEnabled) {
            return true;
        }
        if (event.getAction() == MotionEvent.ACTION_UP) {
            float squareSize = getWidth() / 8f;
            int screenCol = (int) (event.getX() / squareSize);
            int screenRow = (int) (event.getY() / squareSize);
            int row = flipped ? 7 - screenRow : screenRow;
            int col = flipped ? 7 - screenCol : screenCol;
            if (row >= 0 && row < 8 && col >= 0 && col < 8) {
                handleTap(squareName(row, col));
            }
            performClick();
        }
        return true;
    }

    @Override
    public boolean performClick() {
        return super.performClick();
    }

    private void handleTap(String square) {
        if (selectedSquare != null && highlightedTargets.contains(square)) {
            completeMove(selectedSquare, square);
            return;
        }

        if (square.equals(selectedSquare) || !hasMovesFrom(square)) {
            clearSelection();
        } else {
            selectedSquare = square;
            highlightedTargets = legalMoves.stream()
                    .filter(m -> m.startsWith(square))
                    .map(m -> m.substring(2, 4))
                    .collect(Collectors.toCollection(LinkedHashSet::new));
        }
        invalidate();
    }

    private boolean hasMovesFrom(String square) {
        return legalMoves.stream().anyMatch(m -> m.startsWith(square));
    }

    private void completeMove(String from, String to) {
        List<String> matches = legalMoves.stream()
                .filter(m -> m.startsWith(from) && m.regionMatches(2, to, 0, 2))
                .collect(Collectors.toList());

        clearSelection();
        invalidate();

        if (matches.size() > 1) {
            if (listener != null) {
                listener.onPromotionNeeded(from, to, matches);
            }
        } else if (matches.size() == 1 && listener != null) {
            listener.onMoveSelected(matches.get(0));
        }
    }

    private static String squareName(int row, int col) {
        char file = (char) ('a' + col);
        int rank = 8 - row;
        return "" + file + rank;
    }

    // Package-private so PromotionPickerDialog can reuse it instead of duplicating
    // the glyph table.
    static String glyphFor(char piece) {
        switch (piece) {
            case 'K': return "♔";
            case 'Q': return "♕";
            case 'R': return "♖";
            case 'B': return "♗";
            case 'N': return "♘";
            case 'P': return "♙";
            case 'k': return "♚";
            case 'q': return "♛";
            case 'r': return "♜";
            case 'b': return "♝";
            case 'n': return "♞";
            case 'p': return "♟";
            default: return "";
        }
    }
}
