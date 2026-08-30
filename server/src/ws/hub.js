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


module.exports = { attachHub, sendToUser };