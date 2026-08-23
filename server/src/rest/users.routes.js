const express = require('express');
const { requireAuth } = require('./middleware/auth');
const usersRepo = require('../db/repositories/users.repo');

const router = express.Router();

// requireAuth runs before the handler, so an unauthenticated request never
// reaches the database. The id comes only from req.user — never from the path,
// query or body — so a caller cannot ask for someone else's profile.
router.get('/me', requireAuth, async (req, res) => {
    const user = await usersRepo.findById(req.user.id);

    // A valid signature over an account that no longer exists. Not a 401: there
    // is nothing wrong with the token, so refreshing or re-logging in would not
    // help. Without this guard, reading user.username throws and Express turns
    // it into a bodiless HTML 500.
    if (!user) {
        return res.status(404).json({
            error: 'user_not_found',
            message: 'no account matches this token'
        });
    }

    // Only the two fields the ticket asks for. The rest of the row — id and
    // created_at — stays on the server until something needs it.
    return res.status(200).json({ username: user.username, rating: user.rating });
});


module.exports = router;