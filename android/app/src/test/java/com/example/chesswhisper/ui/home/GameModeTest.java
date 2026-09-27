package com.example.chesswhisper.ui.home;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

// Pins the mode vocabulary the Home picker offers. The wire values are the
// server's own (queue.js's MODES); the server rejects anything else with
// queue.rejected, so a typo here would strand a player rather than fail loudly.
public class GameModeTest {

    @Test
    public void offersExactlyClassicEvalAndFeedbackInThatOrder() {
        // No retraction: its assist feature isn't built, so offering it would
        // put players in a game with no assist at all.
        assertArrayEquals(
                new GameMode[] {GameMode.CLASSIC, GameMode.EVAL, GameMode.FEEDBACK},
                GameMode.values());
    }

    @Test
    public void wireValuesMatchTheServersVocabulary() {
        assertEquals("classic", GameMode.CLASSIC.wireValue);
        assertEquals("eval", GameMode.EVAL.wireValue);
        assertEquals("feedback", GameMode.FEEDBACK.wireValue);
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
