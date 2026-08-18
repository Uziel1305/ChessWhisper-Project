const express= require('express');
const router=express.Router();
const argon2 = require('argon2');
const usersRepo = require('../db/repositories/users.repo');



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
module.exports=router;