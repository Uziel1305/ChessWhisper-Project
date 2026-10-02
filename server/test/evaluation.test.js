const request = require('supertest');
const app = require('../src/app');
const pool = require('../src/db/pool');
const hub = require('../src/ws/hub');
const engineClient = require('../src/engine/engineClient');
const GameManager = require('../src/game/GameManager');
const feedbackRepo = require('../src/db/repositories/feedback.repo');

// The engine is mocked: every evaluate() call hands back a promise the test
// resolves by hand, so it controls both *what* the engine says and *when* — which
// is the whole point of the out-of-order cases below. Nothing here needs Docker's
// engine service.
jest.mock('../src/engine/engineClient');

// Not a real socket: sendToUser is spied on and swallowed, so the tests read what
// GameManager tried to send without needing a connected client.
let sent;

// One entry per evaluate() call, in call order — pending[0] is ply 1's engine
// call, pending[1] is ply 2's, and so on.
let pending;

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

// Resolves the engine call for `ply` (1-based) with `cp` — and, for a forced
// mate, its signed white-perspective distance — then lets the continuation
// run. Same { cp, mateIn } shape engineClient.evaluate() resolves.
async function answer(ply, cp, mateIn = null) {
    pending[ply - 1].resolve({ cp, mateIn });
    await new Promise((resolve) => setImmediate(resolve));
}

let userCounter = 0;
async function registerPlayer() {
    userCounter += 1;
    const res = await request(app)
        .post('/api/auth/register')
        .send({ username: `EvaluationTestuser_${userCounter}`, password: 'a-strong-password-123' });
    expect(res.status).toBe(201);
    return res.body.userId;
}

const startedGames = [];

// Colours are coin-flipped inside createGame, so tests always read
// game.whiteUserId / game.blackUserId rather than assuming which user is which.
async function newGame(mode) {
    const players = [{ userId: await registerPlayer() }, { userId: await registerPlayer() }];
    const game = await GameManager.createGame({ mode, timeControl: 600000, players });
    startedGames.push(game);
    return game;
}

// Plays the moves in order, alternating white/black starting with white, and
// returns the FEN each one produced.
async function play(game, ucis) {
    const fens = [];
    for (let i = 0; i < ucis.length; i++) {
        const event = await GameManager.applyMove({
            gameId: game.id,
            userId: i % 2 === 0 ? game.whiteUserId : game.blackUserId,
            uci: ucis[i],
        });
        expect(event).not.toBeNull();
        fens.push(event.fen);
    }
    return fens;
}

// Four plies of an ordinary opening — nobody is mated, so the game stays live.
const FOUR_PLIES = ['e2e4', 'e7e5', 'g1f3', 'b8c6'];
// Fool's mate: the shortest checkmate, four half-moves, the last one mating.
const FOOLS_MATE = ['f2f3', 'e7e5', 'g2g4', 'd8h4'];

// CW-151: filters on the new shared name, eval.update — not the source's
// still-current move.evaluated, which is exactly what makes every eval-mode
// test below red until CW-152 does the actual rename in GameManager.js.
function evalUpdateEvents() {
    return sent
        .filter(([, event]) => event.type === 'eval.update')
        .map(([userId, event]) => [String(userId), event]);
}

// Same shape as evalUpdateEvents(), but for the feedback pipeline's own event
// type — CW-147 split move.evaluated into move.feedback (mover only, carries
// cpLoss) and eval.update (both players), so the two are no longer one
// overloaded type.
function feedbackEvents() {
    return sent
        .filter(([, event]) => event.type === 'move.feedback')
        .map(([userId, event]) => [String(userId), event]);
}

describe('engine evaluation in the move pipeline', () => {
    beforeEach(() => {
        sent = [];
        pending = [];
        engineClient.evaluate.mockReset();
        engineClient.evaluate.mockImplementation(() => {
            const d = deferred();
            pending.push(d);
            return d.promise;
        });
        jest.spyOn(hub, 'sendToUser').mockImplementation((userId, event) => {
            sent.push([userId, event]);
        });
    });

    afterEach(async () => {
        // Ends any game a test left live, which also stops its clocks' pending
        // flag timers so Jest can exit.
        for (const game of startedGames.splice(0)) {
            if (GameManager.get(game.id)) {
                await GameManager.resign({ gameId: game.id, userId: game.whiteUserId });
            }
        }
        jest.restoreAllMocks();
    });

    // Run before as well as after: a run that dies part-way (a hung test, a
    // killed container) never reaches its afterAll, and the rows it leaves behind
    // would make the next run's registrations collide on username.
    async function deleteTestUsers() {
        await pool.query(`
            DELETE FROM games
             WHERE white_user_id IN (SELECT id FROM users WHERE username LIKE 'EvaluationTestuser_%')
                OR black_user_id IN (SELECT id FROM users WHERE username LIKE 'EvaluationTestuser_%')
        `);
        await pool.query("DELETE FROM users WHERE username LIKE 'EvaluationTestuser_%'");
    }

    beforeAll(deleteTestUsers);

    afterAll(async () => {
        await deleteTestUsers();
        await pool.end();
    });

    describe('one evaluation per committed half-move', () => {
        it('calls the engine exactly once per move, each time with that move\'s position', async () => {
            const game = await newGame('eval');

            const fens = await play(game, FOUR_PLIES);

            expect(engineClient.evaluate).toHaveBeenCalledTimes(4);
            fens.forEach((fen, i) => {
                expect(engineClient.evaluate.mock.calls[i][0]).toBe(fen);
            });
        });

        it('evaluates the mating move too, and the game still ends', async () => {
            const game = await newGame('eval');

            const fens = await play(game, FOOLS_MATE);

            // Four calls, the last one for the position after the mate.
            expect(engineClient.evaluate).toHaveBeenCalledTimes(4);
            expect(engineClient.evaluate.mock.calls[3][0]).toBe(fens[3]);

            const gameEnds = sent.filter(([, event]) => event.type === 'game.end');
            expect(gameEnds).toHaveLength(2);
            expect(gameEnds[0][1]).toMatchObject({ result: '0-1', reason: 'checkmate' });
            expect(GameManager.get(game.id)).toBeUndefined();
        });

        it.each(['classic', 'retraction'])('makes no engine call in a %s game', async (mode) => {
            const game = await newGame(mode);

            await play(game, FOUR_PLIES);

            expect(engineClient.evaluate).not.toHaveBeenCalled();
            expect(evalUpdateEvents()).toEqual([]);
        });

        it.each(['eval', 'feedback'])('makes an engine call in a %s game', async (mode) => {
            const game = await newGame(mode);

            await play(game, ['e2e4']);

            expect(engineClient.evaluate).toHaveBeenCalledTimes(1);
        });
    });

    describe('one result serves the bar and the verdict', () => {
        // White-perspective evals for FOUR_PLIES. Read as a game:
        //   ply 1 white  +30           (no verdict: nothing before it)
        //   ply 2 black  +20   black lost 0    -> best
        //   ply 3 white  +120  white gained    -> best
        //   ply 4 black  +400  black lost 280  -> blunder
        const EVALS = [30, 20, 120, 400];

        it('an eval game sends the bar value to both players and no verdict', async () => {
            const game = await newGame('eval');
            await play(game, FOUR_PLIES);
            for (let i = 0; i < EVALS.length; i++) await answer(i + 1, EVALS[i]);

            const events = evalUpdateEvents();
            expect(events).toHaveLength(8); // 4 plies x 2 players
            for (const ply of [1, 2, 3, 4]) {
                const forPly = events.filter(([, e]) => e.ply === ply);
                expect(forPly.map(([userId]) => userId).sort()).toEqual(
                    [String(game.whiteUserId), String(game.blackUserId)].sort()
                );
                for (const [, event] of forPly) {
                    expect(event).toEqual({ type: 'eval.update', ply, evalCp: EVALS[ply - 1] });
                }
            }
        });

        it('a feedback game sends each verdict to the mover only and no bar value', async () => {
            const game = await newGame('feedback');
            await play(game, FOUR_PLIES);
            for (let i = 0; i < EVALS.length; i++) await answer(i + 1, EVALS[i]);

            // Ply 1 has no verdict, so three events, one recipient each. cpLoss
            // per the comment above: ply2 and ply3 both improved (loss clamped
            // to 0), ply4 lost 280.
            expect(feedbackEvents()).toEqual([
                [String(game.blackUserId), { type: 'move.feedback', ply: 2, classification: 'best', cpLoss: 0 }],
                [String(game.whiteUserId), { type: 'move.feedback', ply: 3, classification: 'best', cpLoss: 0 }],
                [String(game.blackUserId), { type: 'move.feedback', ply: 4, classification: 'blunder', cpLoss: 280 }],
            ]);
        });

        it('makes the same number of engine calls whichever feature consumes the result', async () => {
            const evalGame = await newGame('eval');
            await play(evalGame, FOUR_PLIES);
            const evalCalls = engineClient.evaluate.mock.calls.length;

            engineClient.evaluate.mockClear();
            const feedbackGame = await newGame('feedback');
            await play(feedbackGame, FOUR_PLIES);

            expect(evalCalls).toBe(4);
            expect(engineClient.evaluate.mock.calls.length).toBe(4);
        });
    });

    // mateIn rides the same single evaluation as evalCp — no extra engine call.
    // White-perspective and signed: positive = White mates, negative = Black.
    describe('mate distance', () => {
        it('an eval game sends the same signed mateIn to both players', async () => {
            const game = await newGame('eval');
            await play(game, ['e2e4', 'e7e5']);
            await answer(1, 10000, 3);   // White mates in 3
            await answer(2, -10000, -2); // Black mates in 2

            expect(engineClient.evaluate).toHaveBeenCalledTimes(2);
            const events = evalUpdateEvents();
            for (const [ply, evalCp, mateIn] of [[1, 10000, 3], [2, -10000, -2]]) {
                const forPly = events.filter(([, e]) => e.ply === ply);
                expect(forPly.map(([userId]) => userId).sort()).toEqual(
                    [String(game.whiteUserId), String(game.blackUserId)].sort()
                );
                for (const [, event] of forPly) {
                    expect(event).toEqual({ type: 'eval.update', ply, evalCp, mateIn });
                }
            }
        });

        it('an evaluation without a mate carries no mateIn, even right after one that had it', async () => {
            const game = await newGame('eval');
            await play(game, ['e2e4', 'e7e5']);
            await answer(1, 10000, 3);
            await answer(2, 250);

            // Exact equality: the key is absent, not null — a mate from the
            // previous ply is never carried forward onto this one.
            const ply2 = evalUpdateEvents().filter(([, e]) => e.ply === 2).map(([, e]) => e);
            expect(ply2).toEqual([
                { type: 'eval.update', ply: 2, evalCp: 250 },
                { type: 'eval.update', ply: 2, evalCp: 250 },
            ]);
        });

        it('a feedback game classifies a move into mate from the clamped evalCp', async () => {
            const game = await newGame('feedback');
            await play(game, ['e2e4', 'e7e5']);
            await answer(1, 30);
            // Black's reply walks into White's forced mate: 30 -> 10000 from
            // White's side is a 9970-centipawn loss for Black.
            await answer(2, 10000, 3);

            expect(feedbackEvents()).toEqual([
                [String(game.blackUserId), { type: 'move.feedback', ply: 2, classification: 'blunder', cpLoss: 9970 }],
            ]);
            expect(evalUpdateEvents()).toEqual([]);
        });

        it('a feedback game classifies a move between two mates by the mate distance', async () => {
            const game = await newGame('feedback');
            await play(game, ['e2e4', 'e7e5', 'g1f3']);
            // Ply 1 never answers, so only ply 3 can be classified. White had
            // mate in 5 and played into mate in 8: 4 moves conceded against
            // the best continuation's 4, though both evals are the same 10000.
            await answer(2, 10000, 5);
            await answer(3, 10000, 8);

            expect(feedbackEvents()).toEqual([
                [String(game.whiteUserId), { type: 'move.feedback', ply: 3, classification: 'inaccuracy', cpLoss: 0 }],
            ]);
        });
    });

    describe('lost advantage', () => {
        it('adds lostAdvantage to the verdict when the mover went from clearly ahead to clearly behind', async () => {
            const game = await newGame('feedback');
            await play(game, ['e2e4', 'e7e5', 'g1f3']);
            // White +150 -> -150: a 300 cp loss, and the lead changed hands.
            await answer(2, 150);
            await answer(3, -150);

            expect(feedbackEvents()).toEqual([
                [String(game.whiteUserId), {
                    type: 'move.feedback', ply: 3, classification: 'blunder', cpLoss: 300, lostAdvantage: true,
                }],
            ]);
        });
    });

    describe('feedback persistence', () => {
        // Same shape as the socket-routing EVALS above, kept local so this
        // describe reads on its own: ply2/ply3 lose nothing, ply4 is a
        // 280-centipawn blunder.
        const EVALS = [30, 20, 120, 400];

        // The insert is fire-and-forget (GameManager never awaits it), and it's a
        // real Postgres round trip here — unlike the mocked engine, there is no
        // hook to await directly. One process tick is not enough time for it to
        // land, so this polls for the row count the caller expects instead of
        // guessing a fixed delay.
        async function waitForFeedbackRows(gameId, minLength, timeoutMs = 2000) {
            const query = () => pool.query(
                'SELECT ply, owner_user_id, classification, cp_loss FROM feedback WHERE game_id = $1 ORDER BY ply',
                [gameId]
            ).then((result) => result.rows);

            const deadline = Date.now() + timeoutMs;
            let rows = await query();
            while (rows.length < minLength && Date.now() < deadline) {
                await new Promise((resolve) => setTimeout(resolve, 20));
                rows = await query();
            }
            // Returned either way — a short result here fails the assertion that
            // follows with the actual rows, which is more useful than a timeout.
            return rows;
        }

        it('writes a feedback row for the mover with the classification and cpLoss it sent', async () => {
            const game = await newGame('feedback');
            await play(game, FOUR_PLIES);
            for (let i = 0; i < EVALS.length; i++) await answer(i + 1, EVALS[i]);

            const rows = await waitForFeedbackRows(game.id, 3);

            expect(rows).toHaveLength(3);
            expect(rows.map((r) => ({ ...r, owner_user_id: String(r.owner_user_id) }))).toEqual([
                { ply: 2, owner_user_id: String(game.blackUserId), classification: 'best', cp_loss: 0 },
                { ply: 3, owner_user_id: String(game.whiteUserId), classification: 'best', cp_loss: 0 },
                { ply: 4, owner_user_id: String(game.blackUserId), classification: 'blunder', cp_loss: 280 },
            ]);
        });

        it('findByGame returns only the requesting owner\'s rows, never the other player\'s', async () => {
            const game = await newGame('feedback');
            await play(game, FOUR_PLIES);
            for (let i = 0; i < EVALS.length; i++) await answer(i + 1, EVALS[i]);
            await waitForFeedbackRows(game.id, 3);

            const whiteRows = await feedbackRepo.findByGame({ gameId: game.id, ownerUserId: game.whiteUserId });
            const blackRows = await feedbackRepo.findByGame({ gameId: game.id, ownerUserId: game.blackUserId });

            expect(whiteRows.map((r) => r.ply)).toEqual([3]);
            expect(blackRows.map((r) => r.ply)).toEqual([2, 4]);
        });

        it('rejects a second row for a ply that already has one', async () => {
            const game = await newGame('feedback');
            await play(game, FOUR_PLIES);
            await answer(1, 30);
            await answer(2, 180); // writes ply 2 for real
            await waitForFeedbackRows(game.id, 1);

            // The unique constraint is what's under test here, not app logic —
            // 004_feedback.sql's UNIQUE (game_id, ply), the same way moves.repo
            // relies on its own table's constraint rather than checking first.
            await expect(feedbackRepo.insert({
                gameId: game.id, ply: 2, ownerUserId: game.blackUserId,
                classification: 'good', cpLoss: 10,
            })).rejects.toThrow();
        });

        it('still sends the verdict when the write fails, and logs it once', async () => {
            jest.spyOn(feedbackRepo, 'insert').mockRejectedValueOnce(new Error('db down'));
            jest.spyOn(console, 'error').mockImplementation(() => {});
            const game = await newGame('feedback');
            await play(game, ['e2e4', 'e7e5']);

            await answer(1, 30);
            await answer(2, 180);
            await new Promise((resolve) => setImmediate(resolve));

            expect(feedbackEvents()).toEqual([
                [String(game.blackUserId), { type: 'move.feedback', ply: 2, classification: 'mistake', cpLoss: 150 }],
            ]);
            expect(console.error).toHaveBeenCalledTimes(1);

            const rows = (await pool.query('SELECT 1 FROM feedback WHERE game_id = $1', [game.id])).rows;
            expect(rows).toHaveLength(0);
        });
    });

    describe('the first move', () => {
        it('never gets a verdict in a feedback game', async () => {
            const feedbackGame = await newGame('feedback');
            await play(feedbackGame, ['e2e4']);
            await answer(1, 30);
            expect(evalUpdateEvents()).toEqual([]);
        });

        it('gets a bar value in an eval game', async () => {
            const game = await newGame('eval');
            await play(game, ['e2e4']);
            await answer(1, 30);

            expect(evalUpdateEvents().map(([, e]) => e)).toEqual([
                { type: 'eval.update', ply: 1, evalCp: 30 },
                { type: 'eval.update', ply: 1, evalCp: 30 },
            ]);
        });

        it('the second move is classified once both evaluations exist', async () => {
            const game = await newGame('feedback');
            await play(game, ['e2e4', 'e7e5']);
            await answer(1, 30);
            await answer(2, 180); // black lost 150 -> mistake

            expect(feedbackEvents()).toEqual([
                [String(game.blackUserId), { type: 'move.feedback', ply: 2, classification: 'mistake', cpLoss: 150 }],
            ]);
        });
    });

    describe('results arriving out of order', () => {
        it('classifies every move exactly once, whatever order the engine answers in', async () => {
            const game = await newGame('feedback');
            await play(game, ['e2e4', 'e7e5', 'g1f3']);

            // Ply 3 answers first, then ply 1, then ply 2. Nothing can be
            // classified until ply 2 lands, because plies 2 and 3 both need it.
            await answer(3, 150);
            expect(feedbackEvents()).toEqual([]);
            await answer(1, 30);
            expect(feedbackEvents()).toEqual([]);
            await answer(2, 200);

            // Ply 2: black, 30 -> 200 = lost 170 = mistake.
            // Ply 3: white, 200 -> 150 = lost 50 = good.
            expect(feedbackEvents()).toEqual([
                [String(game.blackUserId), { type: 'move.feedback', ply: 2, classification: 'mistake', cpLoss: 170 }],
                [String(game.whiteUserId), { type: 'move.feedback', ply: 3, classification: 'good', cpLoss: 50 }],
            ]);
        });

        it('never sends a verdict twice', async () => {
            const game = await newGame('feedback');
            await play(game, FOUR_PLIES);

            // 4, 2, 3, 1 — a shuffle where several answers each unlock two plies.
            await answer(4, 100);
            await answer(2, 100);
            await answer(3, 100);
            await answer(1, 100);

            const plies = feedbackEvents().map(([, e]) => e.ply).sort();
            expect(plies).toEqual([2, 3, 4]);
        });

        it('an eval game sends each bar value as soon as it arrives, in any order', async () => {
            const game = await newGame('eval');
            await play(game, ['e2e4', 'e7e5']);

            await answer(2, 20);
            expect(evalUpdateEvents().map(([, e]) => e.ply)).toEqual([2, 2]);
            await answer(1, 30);
            expect(evalUpdateEvents().map(([, e]) => e.ply)).toEqual([2, 2, 1, 1]);
        });
    });

    // The engine is a helper, never a dependency: however it misbehaves, the move
    // is committed and reaches both players, and the game carries on.
    describe('a slow or unavailable engine never blocks a move', () => {
        let unhandled;
        const onUnhandled = (reason) => unhandled.push(reason);

        beforeEach(() => {
            unhandled = [];
            process.on('unhandledRejection', onUnhandled);
            // GameManager reports each failed evaluation with console.error; the
            // tests assert on it rather than letting it flood the output.
            jest.spyOn(console, 'error').mockImplementation(() => {});
        });

        afterEach(() => {
            process.off('unhandledRejection', onUnhandled);
        });

        function committedTo(userId) {
            return sent.filter(([id, event]) =>
                String(id) === String(userId) && event.type === 'move.committed');
        }

        it('commits and delivers moves while the engine never answers', async () => {
            engineClient.evaluate.mockImplementation(() => new Promise(() => {}));
            const game = await newGame('eval');

            // If applyMove waited on the engine this would never return.
            const first = await GameManager.applyMove({
                gameId: game.id, userId: game.whiteUserId, uci: 'e2e4',
            });
            expect(first).not.toBeNull();
            expect(committedTo(game.whiteUserId)).toHaveLength(1);
            expect(committedTo(game.blackUserId)).toHaveLength(1);

            // ...and the game is still playable afterwards.
            const second = await GameManager.applyMove({
                gameId: game.id, userId: game.blackUserId, uci: 'e7e5',
            });
            expect(second).not.toBeNull();
            expect(committedTo(game.whiteUserId)).toHaveLength(2);
            expect(evalUpdateEvents()).toEqual([]);
        });

        it('commits and delivers moves when the engine rejects', async () => {
            engineClient.evaluate.mockImplementation(() => Promise.reject(new Error('engine down')));
            const game = await newGame('feedback');

            await play(game, FOUR_PLIES);
            await new Promise((resolve) => setImmediate(resolve));

            expect(committedTo(game.whiteUserId)).toHaveLength(4);
            expect(committedTo(game.blackUserId)).toHaveLength(4);
            expect(evalUpdateEvents()).toEqual([]);
            // One logged line per failed evaluation, and nothing left unhandled.
            expect(console.error).toHaveBeenCalledTimes(4);
            expect(unhandled).toEqual([]);
        });

        it('commits and delivers moves when the engine call throws synchronously', async () => {
            engineClient.evaluate.mockImplementation(() => { throw new Error('bad config'); });
            const game = await newGame('eval');

            await play(game, ['e2e4', 'e7e5']);

            expect(committedTo(game.whiteUserId)).toHaveLength(2);
            expect(committedTo(game.blackUserId)).toHaveLength(2);
            expect(console.error).toHaveBeenCalledTimes(2);
            expect(unhandled).toEqual([]);
        });

        it('a failed evaluation costs only its own verdict and the next one', async () => {
            // Ply 2's engine call fails; 1, 3 and 4 answer. A verdict needs both
            // neighbours, so plies 2 and 3 lose theirs and ply 4 still gets one.
            let call = 0;
            engineClient.evaluate.mockImplementation(() => {
                call += 1;
                return call === 2
                    ? Promise.reject(new Error('one bad call'))
                    : Promise.resolve({ cp: call === 1 ? 30 : call === 3 ? 100 : 400, mateIn: null });
            });
            const game = await newGame('feedback');

            await play(game, FOUR_PLIES);
            await new Promise((resolve) => setImmediate(resolve));

            // Ply 4: black, 100 -> 400 = lost 300 = blunder.
            expect(feedbackEvents()).toEqual([
                [String(game.blackUserId), { type: 'move.feedback', ply: 4, classification: 'blunder', cpLoss: 300 }],
            ]);
            expect(console.error).toHaveBeenCalledTimes(1);
        });

        it('still delivers the mating move\'s evaluation, after game.end', async () => {
            const game = await newGame('eval');
            await play(game, FOOLS_MATE);

            // The game is over and removed by now; the engine answers late.
            expect(GameManager.get(game.id)).toBeUndefined();
            await answer(4, -10000);

            const order = sent.map(([, event]) => event.type);
            const lastEnd = order.lastIndexOf('game.end');
            const lastEvaluated = order.lastIndexOf('eval.update');
            expect(lastEnd).toBeGreaterThan(-1);
            expect(lastEvaluated).toBeGreaterThan(lastEnd);
            expect(evalUpdateEvents().map(([, e]) => e)).toEqual([
                { type: 'eval.update', ply: 4, evalCp: -10000 },
                { type: 'eval.update', ply: 4, evalCp: -10000 },
            ]);
            expect(unhandled).toEqual([]);
        });

        it('still classifies the mating move after game.end, for the mover only', async () => {
            const game = await newGame('feedback');
            await play(game, FOOLS_MATE);

            // Ply 2 never answers, so only ply 4 (needing plies 3 and 4) can be
            // classified. Black mates: the eval goes 100 -> -10000 from white's
            // side, which is a gain for black, so the loss is 0 -> best.
            await answer(3, 100);
            await answer(4, -10000);

            expect(feedbackEvents()).toEqual([
                [String(game.blackUserId), { type: 'move.feedback', ply: 4, classification: 'best', cpLoss: 0 }],
            ]);
            const order = sent.map(([, event]) => event.type);
            expect(order.lastIndexOf('move.feedback')).toBeGreaterThan(order.lastIndexOf('game.end'));
        });
    });
});
