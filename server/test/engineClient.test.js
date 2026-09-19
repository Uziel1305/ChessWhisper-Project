const http = require('http');
const { evaluate, DEFAULT_BUDGET_MS } = require('../src/engine/engineClient');

// A throwaway HTTP server standing in for the engine facade, so these tests need
// no engine and no network beyond loopback. `handler` decides how it answers.
function startStub(handler) {
    const requests = [];
    const server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            requests.push({
                method: req.method,
                url: req.url,
                body: JSON.parse(Buffer.concat(chunks).toString()),
            });
            handler(req, res);
        });
    });
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            resolve({ server, requests, url: `http://127.0.0.1:${server.address().port}` });
        });
    });
}

const FEN = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';

describe('engineClient.evaluate', () => {
    const originalUrl = process.env.ENGINE_URL;
    let stub;

    afterEach(async () => {
        process.env.ENGINE_URL = originalUrl;
        if (stub) {
            // A never-answering stub leaves a connection open; without this
            // close() would wait on it and the test run would hang.
            stub.server.closeAllConnections();
            await new Promise((resolve) => stub.server.close(resolve));
            stub = undefined;
        }
    });

    it('posts the fen and budget to /evaluate and returns the centipawn score', async () => {
        stub = await startStub((req, res) => {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ cp: 27 }));
        });
        process.env.ENGINE_URL = stub.url;

        await expect(evaluate(FEN, 150)).resolves.toBe(27);

        expect(stub.requests).toEqual([
            { method: 'POST', url: '/evaluate', body: { fen: FEN, budgetMs: 150 } },
        ]);
    });

    it('defaults the budget to 200ms', async () => {
        stub = await startStub((req, res) => {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ cp: 0 }));
        });
        process.env.ENGINE_URL = stub.url;

        await evaluate(FEN);

        expect(DEFAULT_BUDGET_MS).toBe(200);
        expect(stub.requests[0].body.budgetMs).toBe(200);
    });

    it('rejects when the engine never answers', async () => {
        stub = await startStub(() => {}); // takes the request and says nothing
        process.env.ENGINE_URL = stub.url;

        // budget 50ms -> the client gives up after 50 + 1000ms.
        await expect(evaluate(FEN, 50)).rejects.toThrow();
    });

    it('rejects when the engine answers with an error status', async () => {
        stub = await startStub((req, res) => {
            res.writeHead(504, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'evaluate_failed' }));
        });
        process.env.ENGINE_URL = stub.url;

        await expect(evaluate(FEN)).rejects.toThrow('engine responded 504');
    });

    it('rejects when the body has no integer cp', async () => {
        stub = await startStub((req, res) => {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ cp: 'lots' }));
        });
        process.env.ENGINE_URL = stub.url;

        await expect(evaluate(FEN)).rejects.toThrow('no integer cp');
    });

    it('rejects when nothing is listening', async () => {
        // Bind to get a free port, then close it so the connection is refused.
        stub = await startStub(() => {});
        process.env.ENGINE_URL = stub.url;
        await new Promise((resolve) => stub.server.close(resolve));

        await expect(evaluate(FEN)).rejects.toThrow();
    });

    it('rejects, rather than throwing synchronously, when ENGINE_URL is unset', async () => {
        delete process.env.ENGINE_URL;

        // No `await` on the call itself: a synchronous throw would escape here.
        const pending = evaluate(FEN);
        await expect(pending).rejects.toThrow('ENGINE_URL is not set');
    });
});
