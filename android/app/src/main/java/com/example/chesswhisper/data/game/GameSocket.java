package com.example.chesswhisper.data.game;

import com.example.chesswhisper.BuildConfig;
import com.example.chesswhisper.data.game.model.MatchFound;
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

    public interface Listener {
        void onMatchFound(MatchFound matchFound);
        void onQueueRejected(String error, String message);
        void onFailure(Throwable t);
    }

    private static volatile GameSocket instance;

    private WebSocket webSocket;
    private Listener listener;

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

    public void connectAndJoinQueue(Listener listener) {
        this.listener = listener;

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
                join.addProperty("mode", "classic");
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
                if ("match.found".equals(type)) {
                    listener.onMatchFound(new Gson().fromJson(json, MatchFound.class));
                } else if ("queue.rejected".equals(type)) {
                    listener.onQueueRejected(
                            json.get("error").getAsString(), json.get("message").getAsString());
                }
            }

            @Override
            public void onFailure(WebSocket ws, Throwable t, Response response) {
                listener.onFailure(t);
            }
        });
    }
}
