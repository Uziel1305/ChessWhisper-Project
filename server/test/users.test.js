const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('../src/app');
const pool = require('../src/db/pool');


// Produces exactly what middleware/auth.js verifies: HS256 over a { sub } claim.
function accessTokenFor(userId){
    return jwt.sign({sub:String(userId)}, process.env.JWT_SECRET, {
    algorithm: 'HS256',
    expiresIn: '15m',
  });
}

// Like the register tests, these hit a real Postgres, so they also prove the
// token's sub actually lines up with a row the repository can find.

describe('GET /api/users/me', ()=>{
    afterAll(async ()=>{
        await pool.query("DELETE FROM users WHERE username LIKE 'testuser_%'")
        await pool.end();
    })

    it('returns 200 and the profile for a valid token', async () => {
    const registered = await request(app)
      .post('/api/auth/register')
      .send({ username: 'testuser_me', password: 'a-strong-password-123' });
    expect(registered.status).toBe(201);
    const res = await request(app)
      .get('/api/users/me')
      .set('Authorization', `Bearer ${accessTokenFor(registered.body.userId)}`);

    expect(res.status).toBe(200);
    expect(res.body.username).toBe('testuser_me');
    expect(res.body.rating).toBeDefined();
    // The hash must never leave the server, so it must never reach the body.
    expect(res.body.password_hash).toBeUndefined();
    })

    // CW-12's second acceptance test: a brand-new player starts at 1000.
    it('reports a newly registered player as rating 1000', async () => {
        const registered = await request(app)
        .post('/api/auth/register')
        .send({ username: 'testuser_me_fresh', password: 'a-strong-password-123' });
        expect(registered.status).toBe(201);

        const res = await request(app)
        .get('/api/users/me')
        .set('Authorization', `Bearer ${accessTokenFor(registered.body.userId)}`);

        expect(res.status).toBe(200);
        expect(res.body.rating).toBe(1000);
    });

    // The four cases below cover each rejection branch of requireAuth: a header
    // that is absent or not a Bearer token, a bad signature, and expiry. None of
    // them needs a real user — the request is turned away before the lookup.
    it('rejects a request with no Authorization header with 401', async () => {
        const res = await request(app).get('/api/users/me');

        expect(res.status).toBe(401);
    });

    
    it('rejects a header that is not a Bearer token with 401', async () => {
        const res = await request(app)
        .get('/api/users/me')
        .set('Authorization', 'Token abc');

        expect(res.status).toBe(401);
    } );

    it('rejects a token signed with the wrong secret with 401', async () => {
        // Well-formed and unexpired — only the signature is wrong, which is what
        // proves the secret is actually being checked.
        const forged = jwt.sign({ sub: '1' }, 'not-the-real-secret', {
        algorithm: 'HS256',
        expiresIn: '15m',
        });

        const res = await request(app)
        .get('/api/users/me')
        .set('Authorization', `Bearer ${forged}`);

        expect(res.status).toBe(401);
    });

    // Expiry is the one rejection whose code is asserted, because it is the one
    // failure the client can recover from on its own: the app keys its refresh
    // off this exact string, so it is a contract and not just a status.
    it('rejects an expired token with 401 access_token_expired', async () => {
        const expired = jwt.sign({ sub: '1' }, process.env.JWT_SECRET, {
        algorithm: 'HS256',
        expiresIn: '-1s',
        });

        const res = await request(app)
        .get('/api/users/me')
        .set('Authorization', `Bearer ${expired}`);

        expect(res.status).toBe(401);
        expect(res.body.error).toBe('access_token_expired');
    });

     // A real signature over an account that no longer exists. requireAuth lets it
    // through — the token is valid — so this 404 comes from the route handler.
    it('returns 404 when the token names a user that no longer exists', async () => {
        const registered = await request(app)
        .post('/api/auth/register')
        .send({ username: 'testuser_me_gone', password: 'a-strong-password-123' });
        expect(registered.status).toBe(201);

        const token = accessTokenFor(registered.body.userId);
        await pool.query('DELETE FROM users WHERE id=$1', [registered.body.userId]);

        const res = await request(app)
        .get('/api/users/me')
        .set('Authorization', `Bearer ${token}`);

        expect(res.status).toBe(404);
        expect(res.body.error).toBe('user_not_found');
    });
});
