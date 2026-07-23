const express= require('express');
const router=express.Router();
const argon2 = require('argon2');
const usersRepo = require('../db/repositories/users.repo');



router.post('/register', async (req,res)=>{
    const { username, password } = req.body;
    if (!username || !password || password.length < 8) {
        return res.status(400).json({
        error: 'validation_error',
        message: 'username and a password of at least 8 characters are required',
        });
    }
    try {
        const passwordHash = await argon2.hash(password);
        const user = await usersRepo.insert(username, passwordHash);
        return res.status(201).json({ userId: user.id });
    } catch (err) {
        if (err instanceof usersRepo.DuplicateUsernameError) {
            return res.status(409).json({
                error: 'username_taken',
                message: 'that username is already taken',
            });
        }
        throw err;
  }
})
module.exports=router;