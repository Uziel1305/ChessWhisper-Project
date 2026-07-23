const authRouter = require('./rest/auth.routes');
const express=require('express')
const app=express()
app.use(express.json())
app.use('/api/auth',authRouter)
module.exports=app
