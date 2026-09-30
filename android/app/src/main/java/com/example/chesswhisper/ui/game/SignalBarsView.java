package com.example.chesswhisper.ui.game;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.util.AttributeSet;
import android.view.View;

import com.example.chesswhisper.R;

// The feedback card's move-quality indicator: five rising bars, like a signal
// strength meter. Draw-only — GameActivity decides how many are filled from
// the server's classification; this view just paints that number.
public class SignalBarsView extends View {

    public static final int BAR_COUNT = 5;

    private final Paint filledPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint dimPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private float gap;
    private int filled = 0;

    public SignalBarsView(Context context) {
        super(context);
        init(context);
    }

    public SignalBarsView(Context context, AttributeSet attrs) {
        super(context, attrs);
        init(context);
    }

    private void init(Context context) {
        dimPaint.setColor(context.getColor(R.color.feedback_bar_dim));
        filledPaint.setColor(context.getColor(R.color.feedback_neutral));
        gap = getResources().getDimension(R.dimen.signal_bar_gap);
    }

    // filled is clamped to 0..BAR_COUNT; 0 means every bar dim.
    public void setLevel(int filled, int color) {
        this.filled = Math.max(0, Math.min(BAR_COUNT, filled));
        filledPaint.setColor(color);
        invalidate();
    }

    @Override
    protected void onDraw(Canvas canvas) {
        super.onDraw(canvas);
        float width = getWidth() - getPaddingLeft() - getPaddingRight();
        float height = getHeight() - getPaddingTop() - getPaddingBottom();
        float barWidth = (width - gap * (BAR_COUNT - 1)) / BAR_COUNT;
        float radius = barWidth / 2f;
        float bottom = getPaddingTop() + height;

        for (int i = 0; i < BAR_COUNT; i++) {
            // Heights step up evenly from a fifth of the view to its full height.
            float barHeight = height * (i + 1) / BAR_COUNT;
            float left = getPaddingLeft() + i * (barWidth + gap);
            canvas.drawRoundRect(left, bottom - barHeight, left + barWidth, bottom,
                    radius, radius, i < filled ? filledPaint : dimPaint);
        }
    }
}
