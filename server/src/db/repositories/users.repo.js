const pool=require('../pool');

// Lets the route answer 409 without knowing anything about Postgres error
// codes. Everything pg-specific stops at this file.
class DuplicateUsernameError extends Error {}

async function findByUsername(username){
    // $1 is a bound parameter, not string interpolation — the value can never
    // be parsed as SQL, so this is injection-safe by construction.
    const result= await pool.query(
        'SELECT id, username, password_hash, rating, created_at FROM users WHERE username=$1',
        [username]
    );
    // undefined when there is no match, which reads naturally at the call site.
    return result.rows[0];
}


async function findById(id){
    // $1 is a bound parameter, not string interpolation — the value can never
    // be parsed as SQL, so this is injection-safe by construction.
    const result= await pool.query(
        'SELECT id, username, rating, created_at FROM users WHERE id=$1',
        [id]
    );
    // undefined when there is no match, which reads naturally at the call site.
    return result.rows[0];
}

async function insert(username, passwordHash){
    try{
            // RETURNING gives back the generated id in the same round trip,
            // instead of inserting and then selecting.
            const result= await pool.query(
            'INSERT INTO users (username,password_hash) VALUES ($1,$2) RETURNING id,username, rating, created_at',
            [username,passwordHash]
        );
        return result.rows[0];
    }catch(err){
        // 23505 is Postgres' unique_violation. Letting the UNIQUE constraint
        // decide — rather than checking first with findByUsername — is what
        // makes this race-free: two simultaneous signups for the same name
        // would both pass a prior check, but only one can win the insert.
        if (err.code === '23505') {
            throw new DuplicateUsernameError(`username "${username}" is already taken`);
        }
        // Anything else is unexpected; let it surface rather than masking it.
        throw err;
    }
}

module.exports={findByUsername,insert,DuplicateUsernameError,findById};

