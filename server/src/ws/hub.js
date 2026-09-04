const jwt= require('jsonwebtoken')
const {WebSocketServer,WebSocket}=require('ws')

// noServer: the handshake is completed by hand below, only after the token
// checks out. Handing the http.Server straight to ws would upgrade first and
// authenticate afterwards, which is exactly backwards.
const wss=new WebSocketServer({noServer:true})
const queue = require('../matchmaking/queue');
const gameManager = require('../game/GameManager');

// userId -> that user's socket. One only: a game cannot be played from two
// places at once, and a second socket creates a second board that can send
// moves and queue joins of its own.
const socketByUser = new Map();



function register(userId, ws) {
    const existing = socketByUser.get(userId);
    // Newest connection wins. Set first, then close: the old socket's close
    // handler runs later and must see itself as already replaced.
    socketByUser.set(userId, ws);

    if (existing && existing !== ws) {
        existing.close(4000, 'replaced by a newer connection');
    }
}

// Returns whether this socket was still the live one. A stale socket closing
// after it has been replaced must not evict its replacement — which is also
// why the caller uses this answer before touching the queue.
function unregister(userId, ws) {
    if (socketByUser.get(userId) !== ws) return false;
    socketByUser.delete(userId);
    return true;
}








function sendToUser(userId, event) {
    // String() because decoded.sub is a string and games.repo hands back a
    // numeric id. Map.get(1) does not find the key '1'.
    const ws = socketByUser.get(String(userId));
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(event));
}


// Mirrors requireAuth. Returns the user id, or null if this is not a token we
// issued — the caller does not care which of the failures it was.
function userIdFrom(request) {
    const header = request.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) return null;

    try {
        const decoded = jwt.verify(
            header.slice('Bearer '.length),
            process.env.JWT_SECRET,
            { algorithms: ['HS256'] }
        );
        return String(decoded.sub);
    } catch (err) {
        // Expired, forged, malformed — all the same to a socket that is not
        // going to open. The client refreshes and reconnects either way.
        return null;
    }
}


// Refuse with a real status line before hanging up. A destroyed socket with no
// response is indistinguishable from a crashed server, and the app would retry
// forever instead of refreshing its token.
function reject(socket) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    socket.destroy();
}


function attachHub(server) {

    // Listen for HTTP requests that ask to upgrade the connection
    // from normal HTTP into a WebSocket connection.
    server.on('upgrade', (request, socket, head) => {

        // request = the HTTP upgrade request
        // socket  = the underlying TCP connection
        // head    = extra bytes Node may already have read

        // Extract only the path from the requested URL.
        // Example: "/ws?x=1" -> "/ws"
        const { pathname } = new URL(request.url, 'http://localhost');

        // Only /ws is allowed to become a WebSocket connection.
        // If the client tries to upgrade another path, close this TCP connection.
        if (pathname !== '/ws') {
            socket.destroy();
            return;
        }

        // Read and verify the JWT from the HTTP upgrade request
        // and get the authenticated user's ID.
        const userId = userIdFrom(request);

        // If authentication failed, reject the upgrade.
        // At this point we still do NOT have a WebSocket yet.
        if (!userId) {
            reject(socket);
            return;
        }

        // Perform the actual HTTP -> WebSocket upgrade.
        // When this callback starts, `ws` is an established WebSocket connection.
        wss.handleUpgrade(request, socket, head, (ws) => {

            // Attach the authenticated user's ID to this WebSocket object.
            // This is our own custom property.
            ws.userId = userId;

            // Store this WebSocket in the hub so we know
            // which connections belong to this user.
            register(userId, ws);

            ws.on('close', () => {
                // Only leave the queue if this was the live socket. A stale one
                // dying must not pull the user's current session out of it.
                if (unregister(userId, ws)) {
                    queue.leave(userId);
                }
            });

            // Tell the WebSocketServer that a new WebSocket connection
            // has been established, so its 'connection' listeners will run.
            wss.emit('connection', ws, request);
        });
    });
}




async function handleQueueJoin(ws, event) {
    let pair;
    try {
        pair = queue.join({
            userId: ws.userId,
            mode: event.mode,
            timeControl: event.timeControl,
        });
    } catch (err) {
        if (err instanceof queue.InvalidQueueRequestError) {
            // An unrecognised mode or time control is answered, never queued.
            // Silently accepting it would leave the player waiting alone forever
            // in a key nobody else can ever join.
            sendToUser(ws.userId, {
                type: 'queue.rejected',
                error: err.code,
                message: err.message,
            });
            return;
        }
        throw err;
    }

    // No pair yet: this player is now waiting, which is not an event worth
    // sending. They hear nothing until someone joins the same key.
    if (!pair) return;

    try {
        await gameManager.createGame(pair);
    } catch (err) {
        // Both players have already been taken out of the waiting list, so
        // staying quiet would strand them: no match, no error, no queue place.
        for (const player of pair.players) {
            sendToUser(player.userId, {
                type: 'queue.rejected',
                error: 'game_not_created',
                message: 'could not start the game, please try again',
            });
        }
        console.error('createGame failed:', err);
    }
}

wss.on('connection', (ws) => {
    ws.on('message', (raw) => {
        if (socketByUser.get(ws.userId) !== ws) {
            return;
        }
        let event;
        try {
            event = JSON.parse(raw);
        } catch (err) {
            // A client sending junk is not a reason to take the server down.
            return;
        }

        if (event.type === 'queue.join') {
            // The listener can be async, but ws.on() does not await its returned Promise.
            // Catch handleQueueJoin() explicitly so a rejection is not left unhandled.
            handleQueueJoin(ws, event).catch((err) => {
                // Only bugs reach here — every expected failure is answered
                // inside handleQueueJoin. The stack goes to the log; the player
                // gets something generic, because we do not know what broke.
                console.error('queue.join failed:', err);

                // The player's queue state is unknown after an unexpected throw:
                // join() may or may not have listed them. Force it to a known
                // one, so the message below is true rather than a guess.
                queue.leave(ws.userId);

                sendToUser(ws.userId, {
                    type: 'queue.rejected',
                    error: 'queue_failed',
                    message: 'could not join the queue, please try again',
                });
            });
            return;
        }
        if (event.type === 'game.move') {
            // applyMove answers an invalid move with null and a log line, so
            // there is nothing to send back and nothing to branch on here. The
            // catch is only for a genuine failure — the moves insert throwing
            // because the database is unreachable — which would otherwise be an
            // unhandled rejection on the socket.
            //
            // Known cost of staying silent there: the server's position has
            // already advanced but neither player was told, so this is the one
            // case where the two sides genuinely diverge. The log is the only
            // signal, and it is worth watching for during CW-57's acceptance run.
            gameManager.applyMove({
                gameId: event.gameId,
                userId: ws.userId,
                uci: event.uci,
            }).catch((err) => {
                console.error('game.move failed:', err);
            });
            return;
        }
        if (event.type === 'queue.leave') {
            queue.leave(ws.userId);
        }
    });
});

module.exports = { attachHub, sendToUser };