const request = require('supertest');
const app = require('../src/app');
const pool = require('../src/db/pool');
const engineUserRepo = require('../src/db/repositories/engineUser.repo');

// The engine's system user, seeded by 007_engine_user.sql. Nothing here deletes
// it: it is part of the schema, not test data.
describe('engine user', () => {
    afterAll(async () => {
        await pool.end();
    });

    it('exists exactly once, under its reserved name', async () => {
        const rows = (await pool.query('SELECT username FROM users WHERE is_engine')).rows;
        expect(rows).toEqual([{ username: 'ChessWhisper Engine' }]);

        const engine = await engineUserRepo.findEngineUser();
        expect(engine).toMatchObject({ username: 'ChessWhisper Engine', rating: 1000 });
    });

    it('cannot have a second engine row', async () => {
        await expect(pool.query(
            "INSERT INTO users (username, password_hash, is_engine) VALUES ('EngineTestuser_dup', 'x', true)"
        )).rejects.toMatchObject({ code: '23505' });
    });

    // A 401, not a 500: the stored hash is a real argon2 hash of a secret nobody
    // kept, so verification simply fails.
    it('cannot be logged into', async () => {
        const res = await request(app)
            .post('/api/auth/login')
            .send({ username: 'ChessWhisper Engine', password: 'any-password-at-all' });
        expect(res.status).toBe(401);
        expect(res.body.error).toBe('invalid_credentials');
    });

    it('cannot be registered over', async () => {
        const res = await request(app)
            .post('/api/auth/register')
            .send({ username: 'ChessWhisper Engine', password: 'a-strong-password-123' });
        expect(res.status).toBe(409);
    });
});
