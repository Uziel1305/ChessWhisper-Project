const express= require('express');
const router=express.Router();
const argon2 = require('argon2');
const crypto = require('crypto');
const usersRepo = require('../db/repositories/users.repo');
const refreshTokensRepo = require('../db/repositories/refreshTokens.repo');
const tokens = require('../auth/tokens');



// Mounted at /api/auth by app.js, so the full path is /api/auth/register.
router.post('/register', async (req,res)=>{
    const { username, password } = req.body;
    // Validated before hashing: argon2 is deliberately slow and memory-hungry,
    // so there is no point spending that on input we are going to reject.
    if (!username || !password || password.length < 8) {
        return res.status(400).json({
        // Both failure shapes are { error, message } — the app parses this
        // into ApiError and shows the message verbatim.
        error: 'validation_error',
        message: 'username and a password of at least 8 characters are required',
        });
    }
    try {
        // argon2 generates its own random salt and encodes the algorithm,
        // version and cost parameters into the returned string, so nothing
        // extra needs storing alongside it. The plaintext is never persisted.
        const passwordHash = await argon2.hash(password);
        const user = await usersRepo.insert(username, passwordHash);
        // 201 Created, and only the id goes back — no token. Registering does
        // not sign the user in; that arrives with login in CW-11.
        return res.status(201).json({ userId: user.id });
    } catch (err) {
        // Raised by the repository when the UNIQUE constraint rejects the insert.
        if (err instanceof usersRepo.DuplicateUsernameError) {
            return res.status(409).json({
                error: 'username_taken',
                message: 'that username is already taken',
            });
        }
        // Unexpected failure — Express 5 catches rejections from async handlers
        // and turns this into a 500 rather than leaving the request hanging.
        throw err;
  }
})

// Mounted at /api/auth, so the full path is /api/auth/login.
router.post('/login', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(400).json({
            error: 'validation_error',
            message: 'username and password are required',
        });
    }

    const user = await usersRepo.findByUsername(username);
    // Same check, same response, whether the username doesn't exist or the
    // password is wrong — the acceptance test requires the failure to never
    // reveal which one it was.
    const passwordMatches = user && await argon2.verify(user.password_hash, password);
    if (!passwordMatches) {
        return res.status(401).json({
            error: 'invalid_credentials',
            message: 'invalid username or password',
        });
    }

    const accessToken = tokens.signAccessToken(user.id);
    const refreshToken = tokens.generateRefreshToken();
    await refreshTokensRepo.insert({
        id: crypto.randomUUID(),
        userId: user.id,
        tokenHash: tokens.hashRefreshToken(refreshToken),
        familyId: crypto.randomUUID(),
        expiresAt: tokens.refreshTokenExpiry(),
    });

    return res.status(200).json({ accessToken, refreshToken, userId: user.id });
});

// Mounted at /api/auth, so the full path is /api/auth/refresh.
router.post('/refresh', async (req, res) => {
    const { refreshToken } = req.body;
    if (!refreshToken) {
        return res.status(400).json({
            error: 'validation_error',
            message: 'refreshToken is required',
        });
    }

    const stored = await refreshTokensRepo.findByHash(tokens.hashRefreshToken(refreshToken));
    if (!stored) {
        return res.status(401).json({
            error: 'invalid_refresh_token',
            message: 'invalid refresh token',
        });
    }

    if (stored.revoked_at) {
        // A token that was already rotated away is being presented again —
        // the cheapest strong signal available that it was stolen and
        // replayed. Kill every token for this user, forcing a full re-login.
        await refreshTokensRepo.revokeAllForUser(stored.user_id);
        return res.status(401).json({
            error: 'refresh_token_reused',
            message: 'refresh token has already been used; please log in again',
        });
    }

    if (stored.expires_at < new Date()) {
        return res.status(401).json({
            error: 'refresh_token_expired',
            message: 'refresh token expired, please log in again',
        });
    }

    const newRefreshToken = tokens.generateRefreshToken();
    const newId = crypto.randomUUID();
    await refreshTokensRepo.insert({
        id: newId,
        userId: stored.user_id,
        tokenHash: tokens.hashRefreshToken(newRefreshToken),
        familyId: stored.family_id,
        expiresAt: tokens.refreshTokenExpiry(),
    });
    await refreshTokensRepo.revoke(stored.id, newId);

    const accessToken = tokens.signAccessToken(stored.user_id);
    return res.status(200).json({ accessToken, refreshToken: newRefreshToken });
});

// Mounted at /api/auth, so the full path is /api/auth/logout.
router.post('/logout', async (req, res) => {
    const { refreshToken } = req.body;
    if (refreshToken) {
        const stored = await refreshTokensRepo.findByHash(tokens.hashRefreshToken(refreshToken));
        if (stored && !stored.revoked_at) {
            await refreshTokensRepo.revoke(stored.id);
        }
    }
    // Always 204 — an unknown or already-revoked token must not be
    // distinguishable from a successful logout.
    return res.status(204).send();
});

module.exports=router;