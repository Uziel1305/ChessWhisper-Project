package com.example.chesswhisper.ui.game;

// Every decision the eval bar makes, as plain Java with no Android types, so it
// is unit-testable on the JVM (see EvalBarModelTest). EvalBarView only draws the
// state held here.
//
// Inputs are always White-perspective, exactly as the server sends them in
// eval.update: evalCp +250 means White is ahead, mateIn 3 means White mates in
// 3 and -3 means Black does. Nothing here knows the local player's colour or
// whether the board is flipped — flipping changes where the view draws things,
// never what this model says.
public final class EvalBarModel {

    // The engine facade clamps a forced mate to +-10000 in evalCp. At (or past)
    // that value the bar is pinned to the end, exactly — not merely very close.
    static final int MATE_CP = 10000;

    // A mate label is shown only for a mate this short (CW-89's decision); a
    // longer mate still pins the bar, just without a label.
    static final int MATE_LABEL_MAX = 5;

    // Lichess's win-probability curve, used here as the bar's S-curve: +200 fills
    // ~68% for White, +500 ~86%. A linear map across +-10000 would move the bar
    // 2% for +200, so ordinary evaluations would be invisible.
    private static final double CURVE = 0.00368208;

    private float whiteFraction = 0.5f;
    private String mateLabel = null;
    private boolean mateForWhite = false;
    private int lastAppliedPly = 0;

    // White's share of the bar, 0..1, for a White-perspective evaluation.
    static float whiteFraction(int evalCp) {
        if (evalCp >= MATE_CP) return 1f;
        if (evalCp <= -MATE_CP) return 0f;
        return (float) (1.0 / (1.0 + Math.exp(-CURVE * evalCp)));
    }

    // "M3" for a mate within MATE_LABEL_MAX moves, otherwise null. Never a minus
    // sign: which side owns the mate is conveyed by where the label is drawn.
    static String mateLabel(Integer mateIn) {
        if (mateIn == null) return null;
        int distance = Math.abs(mateIn);
        return distance <= MATE_LABEL_MAX ? "M" + distance : null;
    }

    // Applies one eval.update. Evaluations can arrive out of order (each one is
    // an independent async engine call on the server), so anything not newer
    // than what's already shown is ignored — older and duplicate plies alike.
    // An accepted update replaces fraction and label together, so a label from
    // an earlier mate never survives an update that doesn't qualify for one.
    // Returns whether the update was accepted.
    public boolean apply(int ply, int evalCp, Integer mateIn) {
        if (ply <= lastAppliedPly) return false;
        lastAppliedPly = ply;
        whiteFraction = whiteFraction(evalCp);
        mateLabel = mateLabel(mateIn);
        mateForWhite = mateLabel != null && mateIn > 0;
        return true;
    }

    public float getWhiteFraction() {
        return whiteFraction;
    }

    // null when no label should be shown.
    public String getMateLabel() {
        return mateLabel;
    }

    // Which side's end of the bar the label belongs to. Only meaningful when
    // getMateLabel() is non-null.
    public boolean isMateForWhite() {
        return mateForWhite;
    }
}
