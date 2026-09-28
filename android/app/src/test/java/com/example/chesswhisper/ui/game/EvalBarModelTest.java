package com.example.chesswhisper.ui.game;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

// Pins every decision the eval bar makes, as plain Java — no View, no Android.
// EvalBarView only draws what this model says. Orientation (a flipped board) is
// deliberately not an input here at all: evalCp and mateIn are White-perspective
// and nothing about the local player's colour can change the model's answers.
public class EvalBarModelTest {

    private static final float EPS = 0.01f;

    // --- fill fraction: White's share of the bar ---------------------------------

    @Test
    public void startsCenteredWithNoMateLabel() {
        EvalBarModel model = new EvalBarModel();
        assertEquals(0.5f, model.getWhiteFraction(), 0f);
        assertNull(model.getMateLabel());
    }

    @Test
    public void anEqualPositionIsExactlyHalf() {
        assertEquals(0.5f, EvalBarModel.whiteFraction(0), 0f);
    }

    @Test
    public void ordinaryEvaluationsMoveTheBarVisibly() {
        // The reason for a non-linear curve: linear across +-10000 would move
        // the bar 2% for +200. These are the S-curve's values.
        assertEquals(0.676f, EvalBarModel.whiteFraction(200), EPS);
        assertEquals(0.863f, EvalBarModel.whiteFraction(500), EPS);
        assertEquals(0.975f, EvalBarModel.whiteFraction(1000), EPS);
    }

    @Test
    public void theCurveIsSymmetricBetweenWhiteAndBlack() {
        for (int cp : new int[] {50, 200, 500, 1000}) {
            assertEquals(1f, EvalBarModel.whiteFraction(cp) + EvalBarModel.whiteFraction(-cp), 1e-6f);
        }
    }

    @Test
    public void theCurveIsMonotonic() {
        float previous = EvalBarModel.whiteFraction(-2000);
        for (int cp = -1900; cp <= 2000; cp += 100) {
            float current = EvalBarModel.whiteFraction(cp);
            assertTrue("fraction must grow with cp at " + cp, current > previous);
            previous = current;
        }
    }

    @Test
    public void mateEvaluationsArePinnedExactlyToTheEnds() {
        // The facade clamps mate to +-10000; the bar must sit exactly at its
        // end for those, not merely very close to it.
        assertEquals(1f, EvalBarModel.whiteFraction(10000), 0f);
        assertEquals(0f, EvalBarModel.whiteFraction(-10000), 0f);
        assertEquals(1f, EvalBarModel.whiteFraction(15000), 0f);
        assertEquals(0f, EvalBarModel.whiteFraction(-15000), 0f);
    }

    // --- mate label ---------------------------------------------------------------

    @Test
    public void aShortMateShowsItsDistanceWithoutAMinusSign() {
        assertEquals("M3", EvalBarModel.mateLabel(3));
        assertEquals("M3", EvalBarModel.mateLabel(-3));
        assertEquals("M1", EvalBarModel.mateLabel(1));
        assertEquals("M5", EvalBarModel.mateLabel(5));
        assertEquals("M5", EvalBarModel.mateLabel(-5));
    }

    @Test
    public void noLabelForALongMateOrNoMate() {
        assertNull(EvalBarModel.mateLabel(6));
        assertNull(EvalBarModel.mateLabel(-6));
        assertNull(EvalBarModel.mateLabel(null));
    }

    @Test
    public void theMateSignOnlyDecidesWhoOwnsIt() {
        EvalBarModel model = new EvalBarModel();

        model.apply(1, 10000, 3);
        assertEquals("M3", model.getMateLabel());
        assertTrue(model.isMateForWhite());

        model.apply(2, -10000, -3);
        assertEquals("M3", model.getMateLabel());
        assertFalse(model.isMateForWhite());
    }

    // --- applying updates ---------------------------------------------------------

    @Test
    public void anAcceptedUpdateSetsTheFraction() {
        EvalBarModel model = new EvalBarModel();
        assertTrue(model.apply(1, 500, null));
        assertEquals(EvalBarModel.whiteFraction(500), model.getWhiteFraction(), 0f);
    }

    @Test
    public void olderAndDuplicatePliesAreIgnored() {
        EvalBarModel model = new EvalBarModel();
        model.apply(3, 500, null);

        assertFalse("older ply", model.apply(2, -500, -2));
        assertFalse("duplicate ply", model.apply(3, -500, -2));

        assertEquals(EvalBarModel.whiteFraction(500), model.getWhiteFraction(), 0f);
        assertNull(model.getMateLabel());
    }

    @Test
    public void aMateLabelIsClearedWhenTheNextUpdateHasNoMate() {
        EvalBarModel model = new EvalBarModel();
        model.apply(1, 10000, 3);
        assertEquals("M3", model.getMateLabel());

        model.apply(2, 300, null);
        assertNull("stale M3 must not survive", model.getMateLabel());
    }

    @Test
    public void aMateLabelIsClearedWhenTheNextMateIsTooLong() {
        EvalBarModel model = new EvalBarModel();
        model.apply(1, 10000, 3);

        model.apply(2, 10000, 8);
        assertNull("mate in 8 is beyond the display cutoff", model.getMateLabel());
        assertEquals(1f, model.getWhiteFraction(), 0f); // still pinned, just unlabeled
    }
}
