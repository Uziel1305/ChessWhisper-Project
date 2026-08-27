const request = require('supertest');
const crypto = require('crypto');
// supertest binds the app to an ephemeral port itself, which is why app.js
// exports the app without calling listen.
const app = require('../src/app');
const pool = require('../src/db/pool');

// Every describe block below hits a real Postgres rather than a mock, so they
// also prove the schema, constraints and pg error handling actually line up.

// Closes the shared pool once, after every describe block below has run —
// each block queries the same pool, so this can't live inside any one of them.
afterAll(async () => {
  await pool.end();
});

describe('POST /api/auth/register', () => {
  afterAll(async () => {
    // Every fixture username shares the testuser_ prefix so this one statement
    // cleans up without touching real rows.
    await pool.query("DELETE FROM users WHERE username LIKE 'testuser_%'");
  });

  it('registers a new user and returns 201 + userId', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ username: 'testuser_valid', password: 'a-strong-password-123' });

    expect(res.status).toBe(201);
    expect(res.body.userId).toBeDefined();
  });

  it('rejects a duplicate username with 409', async () => {
    const user = { username: 'testuser_dup', password: 'a-strong-password-123' };

    // Registers first so the test creates its own precondition instead of
    // depending on a row left behind by an earlier run.
    const first = await request(app).post('/api/auth/register').send(user);
    expect(first.status).toBe(201);

    const second = await request(app).post('/api/auth/register').send(user);
    expect(second.status).toBe(409);
  });

  // The three 400 cases below cover each branch of the validation check
  // separately: falsy username, absent password, and present-but-too-short.
  it('rejects an empty username with 400', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ username: '', password: 'a-strong-password-123' });

    expect(res.status).toBe(400);
  });

  it('rejects a missing password with 400', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ username: 'testuser_nopass' });

    expect(res.status).toBe(400);
  });

  it('rejects a too-short password with 400', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ username: 'testuser_shortpass', password: '123' });

    expect(res.status).toBe(400);
  });
});

describe('POST /api/auth/login', () => {
  const password = 'a-strong-password-123';

  beforeAll(async () => {
    await request(app)
      .post('/api/auth/register')
      .send({ username: 'testuser_login', password });
  });

  afterAll(async () => {
    // ON DELETE CASCADE on refresh_tokens.user_id means this also cleans up
    // any refresh tokens issued to these fixture users.
    await pool.query("DELETE FROM users WHERE username LIKE 'testuser_%'");
  });

  it('logs in with correct credentials and returns tokens', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: 'testuser_login', password });

    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeDefined();
    expect(res.body.refreshToken).toBeDefined();
    expect(res.body.userId).toBeDefined();
  });

  it('rejects a wrong password with 401 invalid_credentials', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: 'testuser_login', password: 'wrong-password' });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_credentials');
  });

  it('rejects an unknown username with the exact same response as a wrong password', async () => {
    const wrongPassword = await request(app)
      .post('/api/auth/login')
      .send({ username: 'testuser_login', password: 'wrong-password' });

    const unknownUser = await request(app)
      .post('/api/auth/login')
      .send({ username: 'testuser_does_not_exist', password: 'wrong-password' });

    expect(unknownUser.status).toBe(wrongPassword.status);
    expect(unknownUser.body).toEqual(wrongPassword.body);
  });

  it('rejects a missing username with 400', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ password });

    expect(res.status).toBe(400);
  });

  it('rejects a missing password with 400', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: 'testuser_login' });

    expect(res.status).toBe(400);
  });
});

describe('POST /api/auth/refresh', () => {
  const password = 'a-strong-password-123';
  const refreshTokensRepo = require('../src/db/repositories/refreshTokens.repo');
  const tokens = require('../src/auth/tokens');

  beforeAll(async () => {
    await request(app)
      .post('/api/auth/register')
      .send({ username: 'testuser_refresh', password });
  });

  afterAll(async () => {
    await pool.query("DELETE FROM users WHERE username LIKE 'testuser_%'");
  });

  async function login() {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: 'testuser_refresh', password });
    return res.body;
  }

  it('rotates: a valid refresh token returns a new access + refresh token', async () => {
    const { refreshToken } = await login();

    const res = await request(app)
      .post('/api/auth/refresh')
      .send({ refreshToken });

    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeDefined();
    expect(res.body.refreshToken).toBeDefined();
    expect(res.body.refreshToken).not.toBe(refreshToken);
  });

  it('detects reuse of an already-rotated token and revokes the whole family', async () => {
    const { refreshToken: original } = await login();

    const rotated = await request(app)
      .post('/api/auth/refresh')
      .send({ refreshToken: original });
    const newRefreshToken = rotated.body.refreshToken;

    // Presenting the already-rotated-away token again looks like theft/replay.
    const reused = await request(app)
      .post('/api/auth/refresh')
      .send({ refreshToken: original });
    expect(reused.status).toBe(401);
    expect(reused.body.error).toBe('refresh_token_reused');

    // The reuse response must have revoked every token for this user,
    // including the one legitimately issued by the rotation above.
    const afterRevocation = await request(app)
      .post('/api/auth/refresh')
      .send({ refreshToken: newRefreshToken });
    expect(afterRevocation.status).toBe(401);
  });

  it('rejects an expired refresh token with 401 refresh_token_expired', async () => {
    const { userId } = await login();
    const plainToken = tokens.generateRefreshToken();

    await refreshTokensRepo.insert({
      id: crypto.randomUUID(),
      userId,
      tokenHash: tokens.hashRefreshToken(plainToken),
      familyId: crypto.randomUUID(),
      expiresAt: new Date(Date.now() - 1000),
    });

    const res = await request(app)
      .post('/api/auth/refresh')
      .send({ refreshToken: plainToken });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('refresh_token_expired');
  });

  it('rejects an unknown refresh token with 401 invalid_refresh_token', async () => {
    const res = await request(app)
      .post('/api/auth/refresh')
      .send({ refreshToken: 'not-a-real-token' });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_refresh_token');
  });

  it('rejects a missing refreshToken with 400', async () => {
    const res = await request(app).post('/api/auth/refresh').send({});

    expect(res.status).toBe(400);
  });
});

describe('POST /api/auth/logout', () => {
  const password = 'a-strong-password-123';

  beforeAll(async () => {
    await request(app)
      .post('/api/auth/register')
      .send({ username: 'testuser_logout', password });
  });

  afterAll(async () => {
    await pool.query("DELETE FROM users WHERE username LIKE 'testuser_%'");
  });

  async function login() {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: 'testuser_logout', password });
    return res.body.refreshToken;
  }

  it('revokes the refresh token: a subsequent refresh with it fails', async () => {
    const refreshToken = await login();

    const logoutRes = await request(app).post('/api/auth/logout').send({ refreshToken });
    expect(logoutRes.status).toBe(204);

    const refreshRes = await request(app).post('/api/auth/refresh').send({ refreshToken });
    expect(refreshRes.status).toBe(401);
  });

  it('is idempotent: logging out twice with the same token still returns 204', async () => {
    const refreshToken = await login();

    const first = await request(app).post('/api/auth/logout').send({ refreshToken });
    const second = await request(app).post('/api/auth/logout').send({ refreshToken });

    expect(first.status).toBe(204);
    expect(second.status).toBe(204);
  });

  it('returns 204 for an unknown token without revealing its validity', async () => {
    const res = await request(app)
      .post('/api/auth/logout')
      .send({ refreshToken: 'not-a-real-token' });

    expect(res.status).toBe(204);
  });
});
