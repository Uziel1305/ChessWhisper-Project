const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const ACCESS_TOKEN_TTL = '15m';
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function signAccessToken(userId) {
    // subject must be a string — jsonwebtoken enforces it, and it's what
    // middleware/auth.js reads back out as decoded.sub.
    return jwt.sign({}, process.env.JWT_SECRET, {
        subject: String(userId),
        expiresIn: ACCESS_TOKEN_TTL,
        algorithm: 'HS256',
    });
}

function generateRefreshToken() {
    // 256 bits of entropy, opaque to the client — nothing to decode, only to
    // hash and compare.
    return crypto.randomBytes(32).toString('base64url');
}

function hashRefreshToken(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
}

function refreshTokenExpiry() {
    return new Date(Date.now() + REFRESH_TOKEN_TTL_MS);
}

module.exports = { signAccessToken, generateRefreshToken, hashRefreshToken, refreshTokenExpiry };
