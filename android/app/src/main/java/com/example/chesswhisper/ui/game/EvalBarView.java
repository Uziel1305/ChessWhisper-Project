package com.example.chesswhisper.ui.game;

import android.animation.ValueAnimator;
import android.content.Context;
import android.graphics.Canvas;
import android.graphics.LinearGradient;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.Shader;
import android.util.AttributeSet;
import android.util.TypedValue;
import android.view.View;
import android.view.animation.DecelerateInterpolator;

import com.example.chesswhisper.R;

// The evaluation bar beside the board (CW-153). A vertical strip split between
// White's share and Black's share, plus an "M3"-style label at the mating
// side's end when a short forced mate is on the board.
//
// Every decision — how full, whether there's a label, whose it is, whether an
// update is stale — lives in EvalBarModel, which is unit-tested on the JVM.
// This class only draws that state. The one thing it adds is presentation:
// the split glides to each new value instead of jumping, but always toward
// exactly what the model says.
public class EvalBarView extends View {

    private static final float LABEL_TEXT_SP = 11f;
    private static final float LABEL_PADDING_DP = 4f;

    private final EvalBarModel model = new EvalBarModel();
    // Mirrors BoardView: false keeps White at the bottom; true (the local player
    // is Black) puts Black at the bottom. Only where things are drawn changes —
    // the model's White-perspective values are never re-signed.
    private boolean flipped = false;

    // What is on screen right now; trails model.getWhiteFraction() only while
    // an animation is running.
    private float displayedFraction;
    private ValueAnimator animator;
    private long animDurationMs;

    private final Paint whitePaint = new Paint();
    private final Paint blackPaint = new Paint();
    private final Paint glowPaint = new Paint();
    private final Paint dividerPaint = new Paint();
    private final Paint labelPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Path clipPath = new Path();
    private int labelOnWhite;
    private int labelOnBlack;
    private int glowColor;
    private int glowTransparent;
    private float labelPadding;
    private float cornerRadius;
    private float glowHeight;
    private float dividerHeight;

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
        dividerPaint.setColor(context.getColor(R.color.eval_bar_divider));
        glowColor = context.getColor(R.color.eval_bar_glow);
        glowTransparent = context.getColor(R.color.eval_bar_glow_transparent);
        labelOnWhite = context.getColor(R.color.eval_bar_label_on_white);
        labelOnBlack = context.getColor(R.color.eval_bar_label_on_black);
        labelPaint.setTextAlign(Paint.Align.CENTER);
        labelPaint.setFakeBoldText(true);
        labelPaint.setTextSize(TypedValue.applyDimension(
                TypedValue.COMPLEX_UNIT_SP, LABEL_TEXT_SP, getResources().getDisplayMetrics()));
        labelPadding = TypedValue.applyDimension(
                TypedValue.COMPLEX_UNIT_DIP, LABEL_PADDING_DP, getResources().getDisplayMetrics());
        cornerRadius = getResources().getDimension(R.dimen.eval_bar_radius);
        glowHeight = getResources().getDimension(R.dimen.eval_bar_glow_height);
        dividerHeight = getResources().getDimension(R.dimen.eval_bar_divider_height);
        animDurationMs = getResources().getInteger(R.integer.eval_bar_anim_ms);
        displayedFraction = model.getWhiteFraction();
    }

    public void setFlipped(boolean flipped) {
        this.flipped = flipped;
        invalidate();
    }

    // One eval.update. Stale (older or duplicate) plies are ignored by the model
    // and cause no redraw. An accepted one glides from wherever the bar is now —
    // mid-animation included — to the model's new value.
    public void setEval(int ply, int evalCp, Integer mateIn) {
        if (model.apply(ply, evalCp, mateIn)) {
            animateTo(model.getWhiteFraction());
        }
    }

    private void animateTo(float target) {
        if (animator != null) {
            animator.cancel();
        }
        animator = ValueAnimator.ofFloat(displayedFraction, target);
        animator.setDuration(animDurationMs);
        animator.setInterpolator(new DecelerateInterpolator());
        animator.addUpdateListener(a -> {
            displayedFraction = (float) a.getAnimatedValue();
            invalidate();
        });
        animator.start();
    }

    @Override
    protected void onDetachedFromWindow() {
        if (animator != null) {
            animator.cancel();
        }
        super.onDetachedFromWindow();
    }

    @Override
    protected void onSizeChanged(int w, int h, int oldw, int oldh) {
        super.onSizeChanged(w, h, oldw, oldh);
        clipPath.reset();
        clipPath.addRoundRect(0, 0, w, h, cornerRadius, cornerRadius, Path.Direction.CW);
        // Built once around y = 0 and translated to the boundary in onDraw, so
        // the animation allocates nothing per frame.
        float half = glowHeight / 2f;
        glowPaint.setShader(new LinearGradient(0, -half, 0, half,
                new int[]{glowTransparent, glowColor, glowTransparent}, null,
                Shader.TileMode.CLAMP));
    }

    @Override
    protected void onDraw(Canvas canvas) {
        super.onDraw(canvas);
        canvas.clipPath(clipPath);
        float width = getWidth();
        float height = getHeight();
        float whiteHeight = height * displayedFraction;

        // Black fills the strip; White's share is laid over it from White's end.
        canvas.drawRect(0, 0, width, height, blackPaint);
        float boundary;
        if (flipped) {
            canvas.drawRect(0, 0, width, whiteHeight, whitePaint);          // White at the top
            boundary = whiteHeight;
        } else {
            canvas.drawRect(0, height - whiteHeight, width, height, whitePaint); // White at the bottom
            boundary = height - whiteHeight;
        }

        // A soft glow band plus a thin bright line on the boundary. None when
        // the bar is pinned to an end — there is no boundary to mark then.
        if (boundary > 0f && boundary < height) {
            float half = glowHeight / 2f;
            canvas.save();
            canvas.translate(0, boundary);
            canvas.drawRect(0, -half, width, half, glowPaint);
            canvas.drawRect(0, -dividerHeight / 2f, width, dividerHeight / 2f, dividerPaint);
            canvas.restore();
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
