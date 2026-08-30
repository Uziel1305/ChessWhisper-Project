const jwt= require('jsonwebtoken')
const {WebSocketServer,WebSocket}=require('ws')

// noServer: the handshake is completed by hand below, only after the token
// checks out. Handing the http.Server straight to ws would upgrade first and
// authenticate afterwards, which is exactly backwards.
const wss=new WebSocketServer({noServer:true})


// userId -> the set of that user's live sockets. A Set rather than one socket
// because a phone that sleeps and reconnects briefly holds two, and a game
// event has to reach whichever one is actually alive.
const socketsByUser = new Map();

function register(userId, ws){
    if(!socketsByUser.has(userId)){
        socketsByUser.set(userId, new Set())
    }
    socketsByUser.get(userId).add(ws)
}

function unregister(userId, ws){
    const sockets = socketsByUser.get(userId)
    if(!sockets){
        return
    }
    sockets.delete(ws);
    // Drop the key rather than leaving an empty Set behind, or the map grows by
    // one dead entry per user who has ever connected.
    if (sockets.size === 0) socketsByUser.delete(userId);
}






// The hub's outbound API. Everything the game sends to a player goes through
// here — GameManager never touches a socket directly.
function sendToUser(userId, event) {
    // String() because decoded.sub is a string and games.repo will hand back a
    // numeric id. Map.get(1) does not find the key '1'.
    const sockets = socketsByUser.get(String(userId));
    if (!sockets) return;

    const payload = JSON.stringify(event);
    for (const ws of sockets) {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(payload);
        }
    }
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
    server.on('upgrade', (request, socket, head) => {
        // Only /ws is a websocket endpoint; every other path stays REST. No
        // status line here, unlike reject() — a client asking to upgrade an
        // unknown path is a bug in the client, not an auth outcome it can act on.
        const { pathname } = new URL(request.url, 'http://localhost');
        if (pathname !== '/ws') {
            socket.destroy();
            return;
        }

        const userId = userIdFrom(request);
        if (!userId) {
            reject(socket);
            return;
        }

        wss.handleUpgrade(request, socket, head, (ws) => {
            ws.userId = userId;
            register(userId, ws);
            ws.on('close', () => unregister(userId, ws));
            wss.emit('connection', ws, request);
        });
    });
}


// ---------------------------------------------------------------------------
// TEMPORARY — CW-36. Delete this whole block when CW-39 lands.
//
// A hardcoded match.found so CW-41 (Android WS client + Play button) has
// something real to build against before matchmaking exists. Every field is
// the shape CW-39 will actually send — only the values are fake — so the
// client parses this and the real thing identically.
// ---------------------------------------------------------------------------
wss.on('connection', (ws) => {
    ws.on('message', (raw) => {
        let event;
        try {
            event = JSON.parse(raw);
        } catch (err) {
            // A client sending junk is not a reason to take the server down.
            return;
        }

        if (event.type !== 'queue.join') return;

        sendToUser(ws.userId, {
            type: 'match.found',
            gameId: 'dev-game-0000',
            color: 'white',
            opponent: { username: 'Dev Opponent', rating: 1000 },
            fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
            // The 20 legal opening moves, UCI. BoardView filters this list by
            // the tapped square — it never computes legality itself.
            legalMoves: [
                'a2a3', 'a2a4', 'b2b3', 'b2b4', 'c2c3', 'c2c4', 'd2d3', 'd2d4',
                'e2e3', 'e2e4', 'f2f3', 'f2f4', 'g2g3', 'g2g4', 'h2h3', 'h2h4',
                'b1a3', 'b1c3', 'g1f3', 'g1h3'
            ],
            // Echoed back, not hardcoded, so Tamir can confirm the server
            // actually read his queue.join payload.
            timeControlMs: event.timeControl ?? 600000,
            // Stubbed now rather than at CW-39: the field exists from the first
            // version, so CW-61 fills it in instead of restructuring the payload.
            clocks: null,
        });
    });
});

module.exports = { attachHub, sendToUser };