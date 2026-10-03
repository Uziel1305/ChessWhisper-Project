const jwt= require('jsonwebtoken')
const {WebSocketServer,WebSocket}=require('ws')

// noServer: the handshake is completed by hand below, only after the token
// checks out. Handing the http.Server straight to ws would upgrade first and
// authenticate afterwards, which is exactly backwards.
const wss=new WebSocketServer({noServer:true})
const queue = require('../matchmaking/queue');
const gameManager = require('../game/GameManager');
const engineOpponent = require('../game/engineOpponent');
const usersRepo = require('../db/repositories/users.repo');

// userId -> that user's socket. One only: a game cannot be played from two
// places at once, and a second socket creates a second board that can send
// moves and queue joins of its own.
const socketByUser = new Map();

// Every piece of async work a socket event started and nobody awaits: the
// disconnect abandon, and the queue.join / game.move / game.resign handlers.
// ws calls its listeners synchronously and discards what they return, so
// without this there is no point anywhere in the process at which that work
// can be waited for — which is what let test teardown delete rows underneath a
// running endGame. Each promise is added with its .catch already attached, so
// it never rejects, and removed again once it settles.
const inFlight = new Set();

function track(promise) {
    inFlight.add(promise);
    promise.finally(() => inFlight.delete(promise));
    return promise;
}

// Set by closeHub(). Once set, no new socket is accepted.
let closing = false;
let closed = null;



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

        // The hub is shutting down: a socket accepted now would start work
        // after closeHub() has already stopped waiting for it.
        if (closing) {
            socket.destroy();
            return;
        }

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

                    // A dropped connection mid-game must not leave the game live
                    // forever with its clock ticking toward a flag nobody's
                    // watching - abandon it on the disconnecting player's behalf.
                    track(gameManager.abandon(userId).catch((err) => {
                        console.error('abandon-on-disconnect failed:', err);
                    }));
                }
            });

            // Tell the WebSocketServer that a new WebSocket connection
            // has been established, so its 'connection' listeners will run.
            wss.emit('connection', ws, request);
        });
    });
}




async function handleQueueJoin(ws, event) {
    // CW-127/128 need each waiter's rating to decide who can pair with whom.
    // Read here, not in queue.js: the queue is deliberately free of the
    // database (see its own header comment), so it only ever receives rating
    // as plain data, the same way it already receives mode and timeControl.
    // No null-check on a missing row: ws.userId came from a verified JWT
    // moments ago, and a user deleted in that window is an edge case nothing
    // else on this path guards against either (createGame's FK violation is
    // the closest precedent, and that's caught downstream too) — a missing
    // row throws here and falls into the same catch-all below as any other
    // unexpected failure.
    const user = await usersRepo.findById(ws.userId);

    let pair;
    try {
        pair = queue.join({
            userId: ws.userId,
            mode: event.mode,
            timeControl: event.timeControl,
            rating: user.rating,
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
            track(handleQueueJoin(ws, event).catch((err) => {
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
            }));
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
            //
            // Once a move commits, the engine replies if this is a game against
            // it. For every other game afterHumanMove returns undefined straight
            // away, so the tracked promise settles exactly when it used to.
            track(gameManager.applyMove({
                gameId: event.gameId,
                userId: ws.userId,
                uci: event.uci,
            }).then((committed) => {
                if (committed) return engineOpponent.afterHumanMove(event.gameId);
            }).catch((err) => {
                console.error('game.move failed:', err);
            }));
            return;
        }
        if (event.type === 'game.resign') {
            // Same shape as game.move: resign() answers an invalid request with
            // null and a log line, so there is nothing to send back. The catch is
            // only for the games.finish write throwing.
            track(gameManager.resign({
                gameId: event.gameId,
                userId: ws.userId,
            }).catch((err) => {
                console.error('game.resign failed:', err);
            }));
            return;
        }
        if (event.type === 'engine.start') {
            // A game against the engine, no queue. Every expected failure is
            // answered inside start() as queue.rejected; only a bug lands here.
            track(engineOpponent.start(ws.userId, event).catch((err) => {
                console.error('engine.start failed:', err);
                sendToUser(ws.userId, {
                    type: 'queue.rejected',
                    error: 'game_not_created',
                    message: 'could not start the game, please try again',
                });
            }));
            return;
        }
        if (event.type === 'queue.leave') {
            queue.leave(ws.userId);
        }
    });
});

// Stops the hub and resolves only once every piece of work its sockets started
// has finished. Nothing calls this in production yet; it is the primitive that
// test teardown and a graceful shutdown both need. Idempotent: a second call
// returns the same promise.
//
// It terminates the sockets itself rather than waiting for someone else to.
// ws 8's wss.close() does not close existing connections, and a socket closed
// from the client side is only noticed here on a later tick — so if a caller
// terminated its clients and then called this, the set below could still be
// empty and this would resolve before abandon() had even started.
//
// Terminating a socket runs the hub's own 'close' handler, which abandons that
// player's live game. So a game still live when this is called ends as
// 'abandoned'. Whether a production shutdown should do that is decided where
// shutdown is wired up, not here.
function closeHub() {
    if (closed) return closed;
    closing = true;

    closed = (async () => {
        // wss.clients rather than socketByUser: it includes sockets that have
        // been replaced by a newer connection and are still closing.
        const sockets = [...wss.clients];
        await Promise.all(sockets.map((ws) => new Promise((resolve) => {
            if (ws.readyState === WebSocket.CLOSED) {
                resolve();
                return;
            }
            // Registered after the hub's own 'close' handler, so by the time
            // this runs that handler has already started and tracked abandon().
            ws.once('close', resolve);
            ws.terminate();
        })));

        // Loop rather than await once: work can still be added while waiting,
        // e.g. by a message that was already being handled.
        while (inFlight.size > 0) {
            await Promise.all([...inFlight]);
        }

        await new Promise((resolve) => wss.close(() => resolve()));
        socketByUser.clear();
    })();

    return closed;
}

module.exports = { attachHub, sendToUser, closeHub };