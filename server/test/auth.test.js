const request = require('supertest');
const app = require('../src/app');
const pool = require('../src/db/pool');

describe('POST /api/auth/register', () => {
  afterAll(async () => {
    await pool.query("DELETE FROM users WHERE username LIKE 'testuser_%'");
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

    const first = await request(app).post('/api/auth/register').send(user);
    expect(first.status).toBe(201);

    const second = await request(app).post('/api/auth/register').send(user);
    expect(second.status).toBe(409);
  });

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
