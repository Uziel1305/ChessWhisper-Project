const pool=require('../pool');

class DuplicateUsernameError extends Error {}

async function findByUsername(username){
    const result= await pool.query(
        'SELECT id, username, password_hash, rating, created_at FROM users WHERE username=$1',
        [username]
    );
    return result.rows[0];
}

async function insert(username, passwordHash){
    try{
            const result= await pool.query(
            'INSERT INTO users (username,password_hash) VALUES ($1,$2) RETURNING id,username, rating, created_at',
            [username,passwordHash]
        );
        return result.rows[0];
    }catch(err){
        if (err.code === '23505') {
            throw new DuplicateUsernameError(`username "${username}" is already taken`);
        }
        throw err;
    }
}

module.exports={findByUsername,insert,DuplicateUsernameError};

