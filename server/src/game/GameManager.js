const crypto = require('crypto');
const gamesRepo = require('../db/repositories/games.repo');
const usersRepo = require('../db/repositories/users.repo');



// gameId -> the live game. The database row is the durable record; this is the
// object moves are applied to. /api/admin/stats reads active games from here.
const games = new Map();

// Every game begins from the same position, so these are constants rather than
// placeholders. CW-45 moves ownership to Game.js, which derives them from
// chess.js once positions can actually change — the values do not change here.
const STARTING_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const STARTING_LEGAL_MOVES = [
    'a2a3', 'a2a4', 'b2b3', 'b2b4', 'c2c3', 'c2c4', 'd2d3', 'd2d4',
    'e2e3', 'e2e4', 'f2f3', 'f2f4', 'g2g3', 'g2g4', 'h2h3', 'h2h4',
    'b1a3', 'b1c3', 'g1f3', 'g1h3'
];


function matchFound({ gameId, color, opponent, timeControlMs }) {
    return {
        type: 'match.found',
        gameId,
        color,
        opponent: { username: opponent.username, rating: opponent.rating },
        fen: STARTING_FEN,
        legalMoves: STARTING_LEGAL_MOVES,
        timeControlMs,
        // Null until CW-61 wires clock.js in. The field is here from the first
        // version so that filling it never restructures the payload — the
        // Android client has been parsing it since the CW-36 stub.
        clocks: null,
    };
}

// Takes the pair the queue produced and turns it into a real game: colours,
// a row, a live entry, and one match.found to each player.
async function createGame({ mode, timeControl, players }) {
    // Required inside the function, not at module scope. hub.js requires this file
    // and this file requires hub.js; at load time hub.js has not yet assigned its
    // module.exports, so a top-level require here would capture an empty object
    // that never gets filled in. By the time a game is created, both are loaded.
    const hub = require('../ws/hub');


    const [first, second] = players;

    // Coin flip. Nothing about the pair's order should decide colour — the
    // queue returns longest-waiter-first, which would otherwise always be white.
    const whiteFirst = Math.random() < 0.5;
    const whiteUserId = whiteFirst ? first.userId : second.userId;
    const blackUserId = whiteFirst ? second.userId : first.userId;

    const id = crypto.randomUUID();

    // Awaited before anything is announced: a failed insert must not leave two
    // players believing they are in a game that was never recorded.
    await gamesRepo.insert({
        id,
        whiteUserId,
        blackUserId,
        mode,
        timeControlMs: timeControl,
    });

    // The queue only carries user ids, so the display names come from here.
    const [whiteUser, blackUser] = await Promise.all([
        usersRepo.findById(whiteUserId),
        usersRepo.findById(blackUserId),
    ]);

    const game = { id, mode, timeControlMs: timeControl, whiteUserId, blackUserId };
    games.set(id, game);

    hub.sendToUser(whiteUserId, matchFound({
        gameId: id,
        color: 'white',
        opponent: blackUser,
        timeControlMs: timeControl,
    }));
    hub.sendToUser(blackUserId, matchFound({
        gameId: id,
        color: 'black',
        opponent: whiteUser,
        timeControlMs: timeControl,
    }));

    return game;
}


function get(gameId) {
    return games.get(gameId);
}

// Called when a game ends, so finished games stop counting as live. CW-69 is
// what actually calls it.
function remove(gameId) {
    return games.delete(gameId);
}

function activeCount() {
    return games.size;
}

module.exports = { createGame, get, remove, activeCount };
