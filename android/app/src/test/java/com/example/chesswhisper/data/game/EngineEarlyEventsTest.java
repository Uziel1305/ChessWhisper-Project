package com.example.chesswhisper.data.game;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import org.junit.Before;
import org.junit.Test;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.CountDownLatch;

public class EngineEarlyEventsTest {

    // A listener is just the list it records into.
    private EngineEarlyEvents<List<String>, String> early;
    private final List<RuntimeException> handOverErrors = new ArrayList<>();
    private final Object connection = new Object();
    private List<String> listener;

    @Before
    public void setUp() {
        early = new EngineEarlyEvents<>((l, e) -> {
            if (e.startsWith("bad")) throw new IllegalStateException(e);
            l.add(e);
        }, handOverErrors::add);
        listener = Collections.synchronizedList(new ArrayList<>());
    }

    @Test
    public void notHolding_deliversImmediatelyToTheCurrentListener() {
        early.offer(connection, "a", () -> listener);
        assertEquals(Collections.singletonList("a"), listener);
    }

    @Test
    public void notHolding_dropsWhenNoOneIsListening() {
        early.offer(connection, "a", () -> null);
        early.release(listener);
        assertTrue(listener.isEmpty());
    }

    @Test
    public void holding_keepsEventsThenHandsThemOverInOrder() {
        early.startHolding(connection);
        early.offer(connection, "a", () -> null);
        early.offer(connection, "b", () -> null);
        assertTrue(listener.isEmpty());

        early.release(listener);
        assertEquals(Arrays.asList("a", "b"), listener);

        // Holding is over: the next event goes straight through.
        early.offer(connection, "c", () -> listener);
        assertEquals(Arrays.asList("a", "b", "c"), listener);
    }

    @Test
    public void holding_neverKeepsAnEventFromAnotherConnection() {
        early.startHolding(connection);
        early.offer(new Object(), "stale", () -> null);
        early.release(listener);
        assertTrue(listener.isEmpty());
    }

    @Test
    public void releaseWithoutAListener_keepsHolding() {
        early.startHolding(connection);
        early.offer(connection, "a", () -> null);
        early.release(null);
        assertTrue(listener.isEmpty());

        early.release(listener);
        assertEquals(Collections.singletonList("a"), listener);
    }

    // A second release is what a rotation does (GameActivity registers again).
    @Test
    public void secondRelease_handsOverNothing() {
        early.startHolding(connection);
        early.offer(connection, "a", () -> null);
        early.release(listener);

        List<String> second = new ArrayList<>();
        early.release(second);
        assertTrue(second.isEmpty());
        assertEquals(Collections.singletonList("a"), listener);
    }

    @Test
    public void reset_discardsHeldEventsAndStopsHolding() {
        early.startHolding(connection);
        early.offer(connection, "a", () -> null);
        early.reset();
        early.release(listener);
        assertTrue(listener.isEmpty());

        // No longer holding: an event with no listener is dropped, as before.
        early.offer(connection, "b", () -> null);
        early.release(listener);
        assertTrue(listener.isEmpty());
    }

    @Test
    public void startHoldingAgain_discardsWhatAnEarlierHoldKept() {
        early.startHolding(connection);
        early.offer(connection, "old", () -> null);
        early.startHolding(connection);
        early.offer(connection, "new", () -> null);
        early.release(listener);
        assertEquals(Collections.singletonList("new"), listener);
    }

    @Test
    public void handOver_skipsAnEventThatFailsAndDeliversTheRest() {
        early.startHolding(connection);
        early.offer(connection, "a", () -> null);
        early.offer(connection, "bad", () -> null);
        early.offer(connection, "b", () -> null);

        early.release(listener);

        assertEquals(Arrays.asList("a", "b"), listener);
        assertEquals(1, handOverErrors.size());
    }

    // GameSocket's real situation: events arrive on OkHttp's thread while the
    // main thread sets the listener and releases. Every event must arrive
    // exactly once and in order, wherever the release lands among them.
    @Test
    public void concurrentOfferAndRelease_deliversEveryEventOnceInOrder() throws Exception {
        for (int run = 0; run < 200; run++) {
            setUp();
            early.startHolding(connection);
            final List<String>[] current = new List[1];
            int count = 50;
            CountDownLatch go = new CountDownLatch(1);

            Thread network = new Thread(() -> {
                await(go);
                for (int i = 0; i < count; i++) {
                    early.offer(connection, "e" + i, () -> current[0]);
                }
            });
            Thread main = new Thread(() -> {
                await(go);
                // As GameSocket.setGameListener does: assign, then release.
                current[0] = listener;
                early.release(listener);
            });
            network.start();
            main.start();
            go.countDown();
            network.join();
            main.join();

            List<String> expected = new ArrayList<>();
            for (int i = 0; i < count; i++) expected.add("e" + i);
            assertEquals("run " + run, expected, listener);
        }
    }

    private static void await(CountDownLatch latch) {
        try {
            latch.await();
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }
}
