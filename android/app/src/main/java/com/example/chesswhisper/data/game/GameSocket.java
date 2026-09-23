package com.example.chesswhisper.data.game;

import com.example.chesswhisper.BuildConfig;
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
        void onGameEnd(GameEnd event);
        void onFailure(Throwable t);
    }

    private static volatile GameSocket instance;

    private WebSocket webSocket;
    private MatchListener matchListener;
    private GameListener gameListener;

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

    public void connectAndJoinQueue(String mode, MatchListener listener) {
        this.matchListener = listener;

        // BASE_URL is "http://host:port/" — same host, ws:// scheme, /ws path.
        String wsUrl = BuildConfig.BASE_URL.replaceFirst("^http", "ws") + "ws";
        // No Authorization header set here: this Request goes through the same
        // OkHttpClient (and so the same interceptor) as every Retrofit call.
        Request request = new Request.Builder().url(wsUrl).build();

        webSocket = ApiClient.getHttpClient().newWebSocket(request, new WebSocketListener() {
            @Override
            public void onOpen(WebSocket ws, Response response) {
                JsonObject join = new JsonObject();
                join.addProperty("type", "queue.join");
                join.addProperty("mode", mode);
                join.addProperty("timeControl", 600000);
                ws.send(join.toString());
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
    }
}
