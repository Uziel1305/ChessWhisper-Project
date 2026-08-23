const authRouter = require('./rest/auth.routes');
const userRouter= require('./rest/users.routes.js')
const express=require('express')
const app=express()
// Parses JSON request bodies into req.body. Without this the routes would see
// req.body as undefined and every register call would fail validation.
app.use(express.json())
// Mounted under a prefix, so the router itself only declares '/register'.
app.use('/api/auth',authRouter)
// Mounted under a prefix, so the router itself only declares '/me'
app.use('/api/users', userRouter)
// Exports the app without calling listen — index.js owns the port, and the
// tests hand this straight to supertest so they never bind one at all.
module.exports=app
