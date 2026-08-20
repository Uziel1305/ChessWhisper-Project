const jwt = require('jsonwebtoken');

// Verifies the short-lived access token on protected routes. Refresh tokens are
// opaque and never reach here — they only ever go to /api/auth/refresh.
function requireAuth(req, res, next) {
    const header = req.headers.authorization;

    // Expect exactly "Bearer <token>".
    if (!header || !header.startsWith('Bearer ')) {
        return res.status(401).json({
            error: 'unauthorized',
            message: 'missing or malformed Authorization header'
        });
    }

    const token = header.slice('Bearer '.length);

    try {
        // Pinning the algorithm is not optional: without it a forged token can
        // declare alg:"none" and jsonwebtoken would accept it unsigned.
        const decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });

        // Downstream routes read the user id from here and never from the body,
        // query or path — so a caller cannot ask for someone else's data.
        req.user = { id: decoded.sub };
        next();
    } catch (err) {
        // Only expiry gets its own code, because it is the one case where the
        // client can recover on its own: refresh, then retry.
        if (err.name === 'TokenExpiredError') {
            return res.status(401).json({
                error: 'access_token_expired',
                message: 'access token expired'
            });
        }

        // Bad signature, malformed, wrong algorithm — all mean the same thing to
        // a caller: this is not a token we issued. Re-login.
        return res.status(401).json({
            error: 'unauthorized',
            message: 'invalid access token'
        });
    }
}



module.exports = { requireAuth };