const http = require('http');
const {
    evaluate,
    chooseMove,
    DEFAULT_BUDGET_MS,
    COOLDOWN_MS,
    _resetBreaker,
    _setClock,
} = require('../src/engine/engineClient');

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

    // The breaker is module-level state: without this, the first test that
    // makes the engine fail would leave every later test facing an open circuit.
    beforeEach(() => {
        _resetBreaker();
    });

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

        // mateIn is always present in what evaluate() resolves — null when the
        // facade's body omitted it — so callers see one shape, never a bare number.
        await expect(evaluate(FEN, 150)).resolves.toEqual({ cp: 27, mateIn: null });

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

        expect(DEFAULT_BUDGET_MS).toBe(800);
        expect(stub.requests[0].body.budgetMs).toBe(800);
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

    it('passes a reported mate distance through unchanged', async () => {
        stub = await startStub((req, res) => {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ cp: -10000, mateIn: -3 }));
        });
        process.env.ENGINE_URL = stub.url;

        await expect(evaluate(FEN)).resolves.toEqual({ cp: -10000, mateIn: -3 });
    });

    it('rejects when mateIn is present but not an integer', async () => {
        stub = await startStub((req, res) => {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ cp: 10000, mateIn: 'soon' }));
        });
        process.env.ENGINE_URL = stub.url;

        await expect(evaluate(FEN)).rejects.toThrow('non-integer mateIn');
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

    // Why this exists: when the engine service dies, the hostname stops
    // resolving, and every lookup of it holds one of libuv's four threads for
    // ~8s — abort or no abort. A handful of those starves every other lookup in
    // the process, including Postgres opening a new connection, which delayed
    // game.end by ~6.5s in a real run. So after a failure the client stops
    // touching the network at all for a while.
    describe('circuit breaker', () => {
        let now;
        let healthy;

        // A stub that fails or succeeds on demand, so one test can walk it
        // through open -> probe -> closed.
        async function startSwitchableStub() {
            stub = await startStub((req, res) => {
                res.writeHead(healthy ? 200 : 500, { 'content-type': 'application/json' });
                res.end(JSON.stringify(healthy ? { cp: 12 } : { error: 'evaluate_failed' }));
            });
            process.env.ENGINE_URL = stub.url;
        }

        beforeEach(() => {
            now = 1_000_000;
            _setClock(() => now);
            healthy = false;
        });

        it('after a failure, rejects at once without contacting the engine', async () => {
            await startSwitchableStub();

            await expect(evaluate(FEN)).rejects.toThrow('engine responded 500');
            expect(stub.requests).toHaveLength(1);

            await expect(evaluate(FEN)).rejects.toThrow('circuit open');
            await expect(evaluate(FEN)).rejects.toThrow('circuit open');
            expect(stub.requests).toHaveLength(1); // still only the first
        });

        it('stays open until the cool-down has fully elapsed', async () => {
            await startSwitchableStub();
            await expect(evaluate(FEN)).rejects.toThrow('engine responded 500');

            now += COOLDOWN_MS - 1;
            healthy = true;
            await expect(evaluate(FEN)).rejects.toThrow('circuit open');
            expect(stub.requests).toHaveLength(1);
        });

        it('after the cool-down, lets one probe through and closes on success', async () => {
            await startSwitchableStub();
            await expect(evaluate(FEN)).rejects.toThrow('engine responded 500');

            now += COOLDOWN_MS;
            healthy = true;
            await expect(evaluate(FEN)).resolves.toEqual({ cp: 12, mateIn: null }); // the probe
            await expect(evaluate(FEN)).resolves.toEqual({ cp: 12, mateIn: null }); // circuit closed again
            expect(stub.requests).toHaveLength(3);
        });

        it('re-opens for a full cool-down when the probe fails', async () => {
            await startSwitchableStub();
            await expect(evaluate(FEN)).rejects.toThrow('engine responded 500');

            now += COOLDOWN_MS;
            await expect(evaluate(FEN)).rejects.toThrow('engine responded 500'); // failed probe
            expect(stub.requests).toHaveLength(2);

            await expect(evaluate(FEN)).rejects.toThrow('circuit open');
            expect(stub.requests).toHaveLength(2);

            now += COOLDOWN_MS;
            healthy = true;
            await expect(evaluate(FEN)).resolves.toEqual({ cp: 12, mateIn: null });
        });

        it('lets only one probe through while it is in flight', async () => {
            await startSwitchableStub();
            await expect(evaluate(FEN)).rejects.toThrow('engine responded 500');
            now += COOLDOWN_MS;

            // Replace the stub with one that holds its answer back.
            let release;
            const held = new Promise((resolve) => { release = resolve; });
            await new Promise((resolve) => stub.server.close(resolve));
            stub = await startStub(async (req, res) => {
                await held;
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ cp: 5 }));
            });
            process.env.ENGINE_URL = stub.url;

            const probe = evaluate(FEN);
            await new Promise((resolve) => setTimeout(resolve, 50)); // let it reach the stub
            expect(stub.requests).toHaveLength(1);

            // A second caller while the probe is out must not become a second probe.
            await expect(evaluate(FEN)).rejects.toThrow('circuit open');
            expect(stub.requests).toHaveLength(1);

            release();
            await expect(probe).resolves.toEqual({ cp: 5, mateIn: null });
        });

        it('never opens while the engine keeps answering', async () => {
            healthy = true;
            await startSwitchableStub();

            for (let i = 0; i < 5; i++) await expect(evaluate(FEN)).resolves.toEqual({ cp: 12, mateIn: null });
            expect(stub.requests).toHaveLength(5);
        });
    });
});

describe('engineClient.chooseMove', () => {
    const originalUrl = process.env.ENGINE_URL;
    let stub;
    let now;

    beforeEach(() => {
        _resetBreaker();
    });

    afterEach(async () => {
        process.env.ENGINE_URL = originalUrl;
        if (stub) {
            stub.server.closeAllConnections();
            await new Promise((resolve) => stub.server.close(resolve));
            stub = undefined;
        }
    });

    function answer(status, body) {
        return (req, res) => {
            res.writeHead(status, { 'content-type': 'application/json' });
            res.end(JSON.stringify(body));
        };
    }

    it('posts to /evaluate with the 200ms default and returns the move the engine chose', async () => {
        stub = await startStub(answer(200, { cp: 30, bestMove: 'e7e5' }));
        process.env.ENGINE_URL = stub.url;

        await expect(chooseMove(FEN)).resolves.toEqual({ bestMove: 'e7e5' });
        expect(stub.requests).toEqual([
            { method: 'POST', url: '/evaluate', body: { fen: FEN, budgetMs: DEFAULT_BUDGET_MS } },
        ]);
    });

    it('returns null when the facade reports no move', async () => {
        stub = await startStub(answer(200, { cp: -10000 }));
        process.env.ENGINE_URL = stub.url;

        await expect(chooseMove(FEN)).resolves.toEqual({ bestMove: null });
    });

    it('rejects a non-string bestMove', async () => {
        stub = await startStub(answer(200, { cp: 0, bestMove: 42 }));
        process.env.ENGINE_URL = stub.url;

        await expect(chooseMove(FEN)).rejects.toThrow('non-string bestMove');
    });

    // One engine, one view of its health: a failure on either call opens the
    // circuit for both, and a probe through either closes it for both.
    it('shares the circuit breaker with evaluate', async () => {
        now = 1_000_000;
        _setClock(() => now);
        let healthy = false;
        stub = await startStub((req, res) => {
            answer(healthy ? 200 : 500, healthy ? { cp: 12, bestMove: 'e7e5' } : { error: 'x' })(req, res);
        });
        process.env.ENGINE_URL = stub.url;

        await expect(chooseMove(FEN)).rejects.toThrow('engine responded 500');
        await expect(evaluate(FEN)).rejects.toThrow('circuit open');
        expect(stub.requests).toHaveLength(1);

        now += COOLDOWN_MS;
        healthy = true;
        await expect(evaluate(FEN)).resolves.toEqual({ cp: 12, mateIn: null }); // the probe
        await expect(chooseMove(FEN)).resolves.toEqual({ bestMove: 'e7e5' }); // closed for both
        expect(stub.requests).toHaveLength(3);
    });
});
