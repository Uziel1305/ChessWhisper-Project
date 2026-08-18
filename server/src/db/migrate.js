const fs=require('fs')
const path=require('path')
const pool=require('./pool')

const MIGRATION_DIR= path.join(__dirname, 'migrations')


// Applies any .sql files that have not run yet. Called from index.js before the
// server binds a port, so a fresh clone gets a working schema with one command.

async function runMigrations() {
    // The ledger of what has already run. IF NOT EXISTS makes the first boot on an
    // empty database work the same as every later one.
    await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    `);

    const {rows}=await pool.query('SELECT filename FROM schema_migrations')
    const applied= new Set(rows.map((r)=>r.filename))
    
    // Filenames are zero-padded (001_, 002_, ...) so a plain sort is dependency order. sort in 
    //increasing order
    const files=fs.readdirSync(MIGRATION_DIR).filter((f)=>f.endsWith('.sql')).sort();
    for(const filename of files){
        if(applied.has(filename)){
            continue;
        }
        const sql=fs.readFileSync(path.join(MIGRATION_DIR,filename), 'utf8');
        //ignore empty files 
        if(sql.trim()===''){
            continue;
        }
        // A dedicated client, because BEGIN/COMMIT have to run on one connection.
        const client=await pool.connect();
        try{
            // The file and its ledger entry commit together, so a crash can never
            // leave a migration applied but unrecorded (or the reverse).
            await client.query('BEGIN')
            await client.query(sql)
            await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [filename]);
            await client.query('COMMIT')
            console.log(`migration applied: ${filename}`);
        }catch(error){
            await client.query('ROLLBACK')
            throw new Error('migration failed: ${filename}\n${error.message}');
        }finally{
            client.release();
        }
    }
}

module.exports = runMigrations;
