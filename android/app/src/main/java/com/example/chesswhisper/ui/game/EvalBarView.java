package com.example.chesswhisper.ui.game;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.util.AttributeSet;
import android.util.TypedValue;
import android.view.View;

import com.example.chesswhisper.R;

// The evaluation bar beside the board (CW-153). A vertical strip split between
// White's share and Black's share, plus an "M3"-style label at the mating
// side's end when a short forced mate is on the board.
//
// Every decision — how full, whether there's a label, whose it is, whether an
// update is stale — lives in EvalBarModel, which is unit-tested on the JVM.
// This class only draws that state.
public class EvalBarView extends View {

    private static final float LABEL_TEXT_SP = 11f;
    private static final float LABEL_PADDING_DP = 4f;

    private final EvalBarModel model = new EvalBarModel();
    // Mirrors BoardView: false keeps White at the bottom; true (the local player
    // is Black) puts Black at the bottom. Only where things are drawn changes —
    // the model's White-perspective values are never re-signed.
    private boolean flipped = false;

    private final Paint whitePaint = new Paint();
    private final Paint blackPaint = new Paint();
    private final Paint labelPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private int labelOnWhite;
    private int labelOnBlack;
    private float labelPadding;

    public EvalBarView(Context context) {
        super(context);
        init(context);
    }

    public EvalBarView(Context context, AttributeSet attrs) {
        super(context, attrs);
        init(context);
    }

    private void init(Context context) {
        whitePaint.setColor(context.getColor(R.color.eval_bar_white));
        blackPaint.setColor(context.getColor(R.color.eval_bar_black));
        labelOnWhite = context.getColor(R.color.eval_bar_label_on_white);
        labelOnBlack = context.getColor(R.color.eval_bar_label_on_black);
        labelPaint.setTextAlign(Paint.Align.CENTER);
        labelPaint.setFakeBoldText(true);
        labelPaint.setTextSize(TypedValue.applyDimension(
                TypedValue.COMPLEX_UNIT_SP, LABEL_TEXT_SP, getResources().getDisplayMetrics()));
        labelPadding = TypedValue.applyDimension(
                TypedValue.COMPLEX_UNIT_DIP, LABEL_PADDING_DP, getResources().getDisplayMetrics());
    }

    public void setFlipped(boolean flipped) {
        this.flipped = flipped;
        invalidate();
    }

    // One eval.update. Stale (older or duplicate) plies are ignored by the model
    // and cause no redraw.
    public void setEval(int ply, int evalCp, Integer mateIn) {
        if (model.apply(ply, evalCp, mateIn)) {
            invalidate();
        }
    }

    @Override
    protected void onDraw(Canvas canvas) {
        super.onDraw(canvas);
        float width = getWidth();
        float height = getHeight();
        float whiteHeight = height * model.getWhiteFraction();

        // Black fills the strip; White's share is laid over it from White's end.
        canvas.drawRect(0, 0, width, height, blackPaint);
        if (flipped) {
            canvas.drawRect(0, 0, width, whiteHeight, whitePaint);          // White at the top
        } else {
            canvas.drawRect(0, height - whiteHeight, width, height, whitePaint); // White at the bottom
        }

        String label = model.getMateLabel();
        if (label == null) return;

        // The label sits at the mating side's own end — that end is always its
        // own colour (a mate pins the bar there), so its contrast colour is fixed.
        boolean forWhite = model.isMateForWhite();
        labelPaint.setColor(forWhite ? labelOnWhite : labelOnBlack);
        boolean atBottom = forWhite != flipped;
        Paint.FontMetrics metrics = labelPaint.getFontMetrics();
        float baseline = atBottom
                ? height - labelPadding - metrics.descent
                : labelPadding - metrics.ascent;
        canvas.drawText(label, width / 2f, baseline, labelPaint);
    }
}
