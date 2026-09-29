package com.example.chesswhisper.ui.home;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.util.Arrays;

// Pins the mode vocabulary. The wire values are the server's own (queue.js's
// MODES); the server rejects anything else with queue.rejected, so a typo here
// would strand a player rather than fail loudly.
public class GameModeTest {

    @Test
    public void pickerOffersExactlyClassicEvalAndFeedbackInThatOrder() {
        // No retraction: its assist feature isn't built, so offering it would
        // put players in a game with no assist at all.
        assertEquals(
                Arrays.asList(GameMode.CLASSIC, GameMode.EVAL, GameMode.FEEDBACK),
                GameMode.pickerModes());
    }

    @Test
    public void retractionIsKnownButNotOffered() {
        assertEquals("retraction", GameMode.RETRACTION.wireValue);
        assertFalse(GameMode.RETRACTION.offeredInPicker);
    }

    @Test
    public void wireValuesMatchTheServersVocabulary() {
        assertEquals("classic", GameMode.CLASSIC.wireValue);
        assertEquals("eval", GameMode.EVAL.wireValue);
        assertEquals("feedback", GameMode.FEEDBACK.wireValue);
        assertEquals("retraction", GameMode.RETRACTION.wireValue);
    }

    @Test
    public void fromWireRecognisesEveryMode() {
        for (GameMode mode : GameMode.values()) {
            assertEquals(mode, GameMode.fromWire(mode.wireValue));
        }
    }

    // History can hold a mode newer than this build; that must not crash.
    @Test
    public void fromWireReturnsNullForAnUnknownMode() {
        assertNull(GameMode.fromWire("some_future_mode"));
        assertNull(GameMode.fromWire(null));
    }

    @Test
    public void theDefaultIsClassic() {
        assertEquals(GameMode.CLASSIC, GameMode.DEFAULT);
    }

    @Test
    public void everyWireValueFitsTheGamesModeColumn() {
        // games.mode is VARCHAR(16) (CLAUDE.md, the `mode` decision).
        for (GameMode mode : GameMode.values()) {
            assertTrue(mode + " is too long for games.mode", mode.wireValue.length() <= 16);
        }
    }
}
