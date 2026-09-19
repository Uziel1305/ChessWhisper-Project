const http = require('http');
const { evaluate } = require('./uci');

// TEMPORARY: a minimal single-endpoint facade so the game server has something
// to call (CW-139). It spawns one engine process per request, with no pool, no
// queue and no concurrency cap — it will not hold the >=100-game target. It is
// replaced wholesale by the real facade (pool.js); nothing here is meant to
// grow.
//
//   POST /evaluate  {fen, budgetMs}  ->  {cp}
//
// cp is in centipawns from WHITE's perspective (UCI reports from the side to
// move; uci.js normalises), mate scores clamped to +-10000.
const PORT = process.env.ENGINE_PORT || 4000;

// FEN characters only. The fen is written to the engine's stdin, so a newline
// in it would let a caller inject their own UCI commands.
const FEN = /^[A-Za-z0-9\/ -]{1,100}$/;
const MAX_BODY_BYTES = 1024;

function reply(res, status, body) {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
}

const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/evaluate') {
        return reply(res, 404, { error: 'not_found' });
    }

    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
            reply(res, 413, { error: 'body_too_large' });
            req.destroy();
            return;
        }
        chunks.push(chunk);
    });
    req.on('end', async () => {
        if (res.writableEnded) return;
        let fen, budgetMs;
        try {
            ({ fen, budgetMs } = JSON.parse(Buffer.concat(chunks).toString()));
        } catch (err) {
            return reply(res, 400, { error: 'bad_request' });
        }
        if (typeof fen !== 'string' || !FEN.test(fen) ||
            !Number.isInteger(budgetMs) || budgetMs < 1 || budgetMs > 5000) {
            return reply(res, 400, { error: 'bad_request' });
        }

        try {
            reply(res, 200, { cp: await evaluate(fen, budgetMs) });
        } catch (err) {
            console.error('evaluate failed:', err.message);
            reply(res, err.timedOut ? 504 : 500, { error: 'evaluate_failed' });
        }
    });
});

server.listen(PORT, () => {
    console.log(`engine facade listening on port ${PORT}`);
});
