const http=require('http')
const jwt=require('jsonwebtoken')
const WebSocket=require('ws')
const app=require('../src/app')
const pool=require('../src/db/pool')
const {attachHub, closeHub}=require('../src/ws/hub')





// The same shape middleware/auth.js verifies. The upgrade checks the very token
// the REST API issued — one server, one token, per the one-server decision.
function accessTokenFor(userId){
    return jwt.sign({sub:String(userId)},process.env.JWT_SECRET,
    {
        algorithm:'HS256',
        expiresIn:'15m'
    });
}


// Unlike the REST tests, these need a real listening port: a handshake is an
// HTTP Upgrade on a real socket and supertest never binds one. The server is
// assembled the way index.js will assemble it after CW-36 — one http.Server
// carrying Express and the hub together, which is what proves they share a port.
let server;
let port;
const openClients=[];

function connect(token){
    const headers= token ? {Authorization: `Bearer ${token}`}:{};
    const client= new WebSocket(`ws://127.0.0.1:${port}/ws`,{headers});
    openClients.push(client);
    // Resolves either way — the assertion is on which outcome happened. First
    // resolve wins, so a trailing 'error' after 'unexpected-response' is ignored.
    return new Promise((resolve)=>{
        client.on('open',()=>resolve({opened:true}))
        client.on('unexpected-response',(req,res)=>{
            resolve({opened: false,status: res.statusCode})
        })
        client.on('error',()=>{
            resolve({opened: false, status:null});
        })
    })
}

// No user rows anywhere below: CW-36 verifies the signature and attaches the id,
// it does not look the account up. So there is nothing to clean out of Postgres.
describe('websocket upgrade at /ws',()=>{
    beforeAll(async () => {
        server=http.createServer(app);
        attachHub(server);
        // Port 0 lets the OS pick a free one, so these never collide with the
        // running container or with each other.
        await new Promise((resolve) => server.listen(0, resolve));
        port=server.address().port;
    })
    afterAll(async () => {
        // No games here, but every open socket's close still runs the hub's
        // disconnect handler. closeHub() lets that finish before the pool ends.
        await closeHub();
        for(const client of openClients){
            client.terminate();
        }
        await new Promise((resolve)=> server.close(resolve));
        // Importing app constructs the pool even though nothing queries it. so we need to close it
        await pool.end();
    })
    it('completes the handshake for a valid access token', async ()=>{
        const result=await connect(accessTokenFor(1));
        expect(result.opened).toBe(true)
    })


    it('rejects an upgrade with no Authorization header', async () => {
        const result = await connect(null);

        expect(result.opened).toBe(false);
        // A written 401 status line, not a silently destroyed socket — the client
        // must be able to tell "not allowed" apart from "server is down".
        expect(result.status).toBe(401);
    });


    
    it('rejects an expired access token', async () => {
        const expired = jwt.sign({ sub: '1' }, process.env.JWT_SECRET, {
                algorithm: 'HS256',
                expiresIn: '-1s',
                });

        const result = await connect(expired);

        expect(result.opened).toBe(false);
        expect(result.status).toBe(401);
    });

    // Beyond the ticket's three cases. The upgrade verifies the token itself
    // instead of going through requireAuth, so nothing else proves the secret is
    // really checked on this path. Delete it if you want to stay strictly on-ticket.
    it('rejects a token signed with the wrong secret', async () => {
        const forged = jwt.sign({ sub: '1' }, 'not-the-real-secret', {
        algorithm: 'HS256',
        expiresIn: '15m',
        });

        const result = await connect(forged);

        expect(result.opened).toBe(false);
        expect(result.status).toBe(401);
    });










     

})






