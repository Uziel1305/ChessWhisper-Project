const express = require('express');
const { requireAuth } = require('./middleware/auth');
const gamesRepo = require('../db/repositories/games.repo');

const router = express.Router();

// How many recent games the home screen shows. The total still counts them all.
const HISTORY_LIMIT = 20;

// Win/loss/draw from this player's side. Worked out here rather than on the
// client, which carries no chess logic — it only renders what it is told.
function outcomeFor(result, color) {
    if (result === '1/2-1/2') return 'draw';
    const whiteWon = result === '1-0';
    return (color === 'white') === whiteWon ? 'win' : 'loss';
}

// Same shape as /api/users/me: requireAuth first, and the id only ever comes
// from req.user, so a caller cannot read another player's history.
router.get('/history', requireAuth, async (req, res) => {
    const [rows, total] = await Promise.all([
        gamesRepo.findHistoryByUser(req.user.id, HISTORY_LIMIT),
        gamesRepo.countFinishedByUser(req.user.id),
    ]);

    const games = rows.map((row) => ({
        id: row.id,
        mode: row.mode,
        timeControlMs: row.time_control_ms,
        color: row.color,
        opponent: row.opponent_username,
        outcome: outcomeFor(row.result, row.color),
        reason: row.reason,
        // null, not 0, when there is no rating_history row: "unknown" and
        // "unchanged" are different things to show.
        ratingDelta: row.rating_after == null ? null : row.rating_after - row.rating_before,
        endedAt: row.ended_at,
    }));

    return res.status(200).json({ total, games });
});

module.exports = router;
