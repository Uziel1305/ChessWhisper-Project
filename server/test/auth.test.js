const request = require('supertest');
// supertest binds the app to an ephemeral port itself, which is why app.js
// exports the app without calling listen.
const app = require('../src/app');
const pool = require('../src/db/pool');

// These hit a real Postgres rather than a mock, so they also prove the schema,
// the UNIQUE constraint and the pg error handling actually line up.
describe('POST /api/auth/register', () => {
  afterAll(async () => {
    // Every fixture username shares the testuser_ prefix so this one statement
    // cleans up without touching real rows.
    await pool.query("DELETE FROM users WHERE username LIKE 'testuser_%'");
    // Closes the pool; otherwise the open connections keep Jest from exiting.
    await pool.end();
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
