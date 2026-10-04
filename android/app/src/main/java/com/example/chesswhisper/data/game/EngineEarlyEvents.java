package com.example.chesswhisper.data.game;

import java.util.ArrayList;
import java.util.List;
import java.util.function.Consumer;
import java.util.function.Supplier;

// Holds the in-game events of a game against the engine that arrive before the
// game screen is listening, and hands them over in order once it is.
//
// Why only engine games: there the engine, as White, moves about half a second
// after match.found, and a slow-to-open GameActivity (a cold emulator) had not
// registered its listener yet, so GameSocket dropped the move and the board stayed
// stuck on the start position. In a game between two people GameSocket never uses
// this class, so it keeps behaving exactly as before, early events included.
//
// Holding starts at match.found on the connection that asked for the engine game
// and ends at the first release() with a listener. Everything is under one lock,
// so an event can never slip between "is anyone listening?" and "keep it".
//
// Plain Java on purpose (no Android, no OkHttp), so it is unit-tested on the JVM.
final class EngineEarlyEvents<L, E> {

    interface Deliverer<L, E> {
        void deliver(L listener, E event);
    }

    private final Object lock = new Object();
    private final Deliverer<L, E> deliverer;
    private final Consumer<RuntimeException> onHandOverError;

    // The connection being held for, or null when nothing is held.
    private Object holdingFor;
    private final List<E> held = new ArrayList<>();

    EngineEarlyEvents(Deliverer<L, E> deliverer, Consumer<RuntimeException> onHandOverError) {
        this.deliverer = deliverer;
        this.onHandOverError = onHandOverError;
    }

    // match.found arrived on this connection: keep its in-game events until the
    // game screen listens.
    void startHolding(Object connection) {
        synchronized (lock) {
            holdingFor = connection;
            held.clear();
        }
    }

    // While holding for this connection, keeps the event. Otherwise behaves as
    // GameSocket always has: delivered if a listener is set, dropped if not.
    // The listener is read inside the lock, so one set just before by
    // GameSocket.setGameListener (which then calls release) is always seen.
    void offer(Object connection, E event, Supplier<L> currentListener) {
        synchronized (lock) {
            if (holdingFor != null && holdingFor == connection) {
                held.add(event);
                return;
            }
            L listener = currentListener.get();
            if (listener != null) {
                deliverer.deliver(listener, event);
            }
        }
    }

    // The game screen is listening: hand over what was held, in arrival order,
    // and stop holding. A no-op with no listener or when nothing is held — which
    // is every call in a game between two people, and every call after the first.
    // An event that fails to hand over is reported and skipped (it would have been
    // lost before this class existed); it never stops the rest or reaches the caller.
    void release(L listener) {
        synchronized (lock) {
            if (listener == null || holdingFor == null) return;
            holdingFor = null;
            for (E event : held) {
                try {
                    deliverer.deliver(listener, event);
                } catch (RuntimeException e) {
                    onHandOverError.accept(e);
                }
            }
            held.clear();
        }
    }

    // A new connection, or the game is over: nothing carries over.
    void reset() {
        synchronized (lock) {
            holdingFor = null;
            held.clear();
        }
    }
}
