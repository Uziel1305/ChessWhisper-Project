package com.example.chesswhisper.data.game;

import android.util.Log;

import com.example.chesswhisper.BuildConfig;
import com.example.chesswhisper.data.game.model.EvalUpdate;
import com.example.chesswhisper.data.game.model.GameEnd;
import com.example.chesswhisper.data.game.model.MatchFound;
import com.example.chesswhisper.data.game.model.MoveCommitted;
import com.example.chesswhisper.data.game.model.MoveFeedback;
import com.example.chesswhisper.data.network.ApiClient;
import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;

// Singleton: per the "one server, one port" design, one WS connection carries the
// whole game (queue.join -> match.found -> move.committed -> game.end), so the
// connection this opens must survive the Home -> GameActivity navigation rather
// than being torn down and reopened.
public final class GameSocket {

    // Matchmaking-phase events (Home) and in-game events (GameActivity) are split
    // into two listener interfaces rather than one, so neither screen has to
    // implement methods for events it doesn't care about.
    public interface MatchListener {
        void onMatchFound(MatchFound matchFound);
        void onQueueRejected(String error, String message);
        void onFailure(Throwable t);
    }

    public interface GameListener {
        void onMoveCommitted(MoveCommitted event);
        void onMoveFeedback(MoveFeedback event);
        void onEvalUpdate(EvalUpdate event);
        void onGameEnd(GameEnd event);
        void onFailure(Throwable t);
    }

    private static volatile GameSocket instance;

    private WebSocket webSocket;
    private MatchListener matchListener;
    private GameListener gameListener;

    private static final String TAG = "GameSocket";

    // Engine games only: in-game events that arrive before GameActivity listens
    // are held here instead of dropped (see EngineEarlyEvents). A game between
    // two people never touches it.
    private final EngineEarlyEvents<GameListener, JsonObject> engineEarlyEvents =
            new EngineEarlyEvents<>(GameSocket::deliverGameEvent,
                    e -> Log.w(TAG, "dropped an early engine-game event", e));
    // Identifies the connection opened by the latest connect(), so that a late
    // message from an older socket is never held into the next game.
    private volatile Object currentConnection;

    private GameSocket() {
    }

    public static GameSocket getInstance() {
        if (instance == null) {
            synchronized (GameSocket.class) {
                if (instance == null) {
                    instance = new GameSocket();
                }
            }
        }
        return instance;
    }

    // The picker for it is deferred; every game is 10 minutes until it exists.
    private static final int TIME_CONTROL_MS = 600000;

    // Waits for a human opponent in the matchmaking queue.
    public void connectAndJoinQueue(String mode, MatchListener listener) {
        JsonObject join = new JsonObject();
        join.addProperty("type", "queue.join");
        join.addProperty("mode", mode);
        join.addProperty("timeControl", TIME_CONTROL_MS);
        connect(join, listener, false);
    }

    // Starts a game against the engine at once — no queue. The server answers
    // with the same match.found (or queue.rejected), so the same listener serves.
    public void connectAndStartEngineGame(String mode, MatchListener listener) {
        JsonObject start = new JsonObject();
        start.addProperty("type", "engine.start");
        start.addProperty("mode", mode);
        start.addProperty("timeControl", TIME_CONTROL_MS);
        connect(start, listener, true);
    }

    // Opens the socket and sends firstMessage once it is open. One connection
    // and one dispatcher for both ways a game can start. holdEarlyEvents is true
    // only for an engine game: there, in-game events that arrive before the game
    // screen listens are held for it rather than dropped. For a game between two
    // people it is false, and every message takes exactly the path it always has.
    private void connect(JsonObject firstMessage, MatchListener listener, boolean holdEarlyEvents) {
        this.matchListener = listener;
        final Object connection = new Object();
        currentConnection = connection;
        engineEarlyEvents.reset();

        // BASE_URL is "http://host:port/" — same host, ws:// scheme, /ws path.
        String wsUrl = BuildConfig.BASE_URL.replaceFirst("^http", "ws") + "ws";
        // No Authorization header set here: this Request goes through the same
        // OkHttpClient (and so the same interceptor) as every Retrofit call.
        Request request = new Request.Builder().url(wsUrl).build();

        webSocket = ApiClient.getHttpClient().newWebSocket(request, new WebSocketListener() {
            @Override
            public void onOpen(WebSocket ws, Response response) {
                ws.send(firstMessage.toString());
            }

            @Override
            public void onMessage(WebSocket ws, String text) {
                JsonObject json;
                try {
                    json = JsonParser.parseString(text).getAsJsonObject();
                } catch (RuntimeException e) {
                    return;
                }
                String type = json.has("type") ? json.get("type").getAsString() : null;
                if (type == null) {
                    return;
                }
                // Engine games only. A match.found on this connection starts
                // holding, and the in-game events go through engineEarlyEvents,
                // which delivers them just as below once the game screen
                // listens. Human games skip this block entirely.
                if (holdEarlyEvents) {
                    if ("match.found".equals(type) && connection == currentConnection) {
                        engineEarlyEvents.startHolding(connection);
                    }
                    if (isInGameEvent(type)) {
                        engineEarlyEvents.offer(connection, json, () -> gameListener);
                        return;
                    }
                }
                switch (type) {
                    case "match.found":
                        if (matchListener != null) {
                            matchListener.onMatchFound(new Gson().fromJson(json, MatchFound.class));
                        }
                        break;
                    case "queue.rejected":
                        if (matchListener != null) {
                            matchListener.onQueueRejected(
                                    json.get("error").getAsString(), json.get("message").getAsString());
                        }
                        break;
                    case "move.committed":
                        if (gameListener != null) {
                            gameListener.onMoveCommitted(new Gson().fromJson(json, MoveCommitted.class));
                        }
                        break;
                    case "move.feedback":
                        if (gameListener != null) {
                            gameListener.onMoveFeedback(new Gson().fromJson(json, MoveFeedback.class));
                        }
                        break;
                    case "eval.update":
                        if (gameListener != null) {
                            gameListener.onEvalUpdate(new Gson().fromJson(json, EvalUpdate.class));
                        }
                        break;
                    case "game.end":
                        if (gameListener != null) {
                            gameListener.onGameEnd(new Gson().fromJson(json, GameEnd.class));
                        }
                        break;
                    default:
                        break;
                }
            }

            @Override
            public void onFailure(WebSocket ws, Throwable t, Response response) {
                if (matchListener != null) {
                    matchListener.onFailure(t);
                }
                if (gameListener != null) {
                    gameListener.onFailure(t);
                }
            }
        });
    }

    // Set once GameActivity takes over from Home. The same connection keeps
    // running — nothing here reconnects.
    public void setGameListener(GameListener listener) {
        this.gameListener = listener;
        // Hands over an engine game's held events. A no-op in every other case.
        engineEarlyEvents.release(listener);
    }

    private static boolean isInGameEvent(String type) {
        switch (type) {
            case "move.committed":
            case "move.feedback":
            case "eval.update":
            case "game.end":
                return true;
            default:
                return false;
        }
    }

    // The engine-game path's delivery: the same parse-and-call as the in-game
    // cases of onMessage's switch, which human games still use unchanged.
    private static void deliverGameEvent(GameListener listener, JsonObject json) {
        switch (json.get("type").getAsString()) {
            case "move.committed":
                listener.onMoveCommitted(new Gson().fromJson(json, MoveCommitted.class));
                break;
            case "move.feedback":
                listener.onMoveFeedback(new Gson().fromJson(json, MoveFeedback.class));
                break;
            case "eval.update":
                listener.onEvalUpdate(new Gson().fromJson(json, EvalUpdate.class));
                break;
            case "game.end":
                listener.onGameEnd(new Gson().fromJson(json, GameEnd.class));
                break;
            default:
                break;
        }
    }

    public void sendMove(String gameId, String uci) {
        JsonObject move = new JsonObject();
        move.addProperty("type", "game.move");
        move.addProperty("gameId", gameId);
        move.addProperty("uci", uci);
        webSocket.send(move.toString());
    }

    public void resign(String gameId) {
        JsonObject resign = new JsonObject();
        resign.addProperty("type", "game.resign");
        resign.addProperty("gameId", gameId);
        webSocket.send(resign.toString());
    }

    // Called when the screen that started matchmaking goes away for good without
    // a match (Home finished by Back). Closing the socket is what takes the player
    // out of the server's waiting list — the server's close handler runs
    // queue.leave — so they can't be matched later as a ghost who never sees the
    // game. Only acts if `owner` is still the current listener: a screen that has
    // already been superseded by a newer matchmaking session must never tear that
    // newer session's socket down.
    public void cancelMatchmaking(MatchListener owner) {
        if (owner != null && owner == matchListener) {
            disconnect();
        }
    }

    // Called when GameActivity is actually leaving for good (game over, resigned,
    // or backed out) — never on a lifecycle event that only pauses it, like Home
    // being pressed. close(), not cancel(): a graceful close still delivers any
    // already-queued send (e.g. a resign just sent) before the connection tears
    // down, where cancel() could drop it. Resets everything to a clean slate so
    // the next connectAndJoinQueue() call starts fresh.
    public void disconnect() {
        if (webSocket != null) {
            webSocket.close(1000, "leaving");
            webSocket = null;
        }
        matchListener = null;
        gameListener = null;
        currentConnection = null;
        engineEarlyEvents.reset();
    }
}
