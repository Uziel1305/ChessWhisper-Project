const { spawn } = require('child_process');
const readline = require('readline');
const ENGINE_PATH = process.env.ENGINE_BINARY_PATH || '/app/engine/chesswhisper_engine';
// Spawns the binary and resolves once it has completed the uci/uciok
// handshake. Nothing here sends 'position' or 'go' yet — that's the real UCI
// loop CW-81 builds. This only proves the facade can talk to the process at all.

function handshake(){
    return new Promise((resolve,reject)=>{
        //craetes a new process
        const child=spawn(ENGINE_PATH);
        const lines=readline.createInterface({input:child.stdout});
        child.on('error',reject);
        lines.on('line',(line)=>{
            if(line=='uciok'){
                lines.close()
                resolve(child)
            }
        })
        child.stdin.write('uci\n');
    })
}

// Mate scores have no centipawn value; they are clamped to this so the game
// server only ever sees a plain number (and cp loss stays well-defined).
const MATE_CP = 10000;

// TEMPORARY, like index.js: evaluates one position with a throwaway process and
// resolves the score in centipawns from WHITE's perspective. UCI scores are
// from the side to move, so the sign is flipped when black is on move. This is
// also what makes terminal positions work: checkmate reports 'mate 0' (the side
// to move has been mated) and stalemate reports 'cp 0'.
// Rejects after budgetMs + 500ms (err.timedOut) so a stuck engine can never
// hold a request open — the child is always killed on the way out.
function evaluate(fen, budgetMs) {
    return new Promise((resolve, reject) => {
        const child = spawn(ENGINE_PATH);
        const whiteToMove = fen.split(' ')[1] !== 'b';
        let score = null;
        let settled = false;
        let timer;

        const finish = (err, value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            child.kill();
            if (err) reject(err);
            else resolve(value);
        };
        timer = setTimeout(() => {
            const err = new Error('engine timed out');
            err.timedOut = true;
            finish(err);
        }, budgetMs + 500);

        child.on('error', finish);
        child.stdin.on('error', finish);
        child.on('exit', () => finish(new Error('engine exited before answering')));

        const lines = readline.createInterface({ input: child.stdout });
        lines.on('line', (line) => {
            if (line === 'uciok') {
                child.stdin.write('isready\n');
            } else if (line === 'readyok') {
                child.stdin.write(`position fen ${fen}\ngo movetime ${budgetMs}\n`);
            } else if (line.startsWith('info ')) {
                const m = line.match(/score (cp|mate) (-?\d+)/);
                if (m) {
                    const n = Number(m[2]);
                    const side = m[1] === 'cp'
                        ? Math.max(-MATE_CP, Math.min(MATE_CP, n))
                        : (n > 0 ? MATE_CP : -MATE_CP);
                    score = whiteToMove ? side : -side;
                }
            } else if (line.startsWith('bestmove')) {
                if (score === null) finish(new Error('engine reported no score'));
                else finish(null, score);
            }
        });

        child.stdin.write('uci\n');
    });
}

module.exports = { handshake, evaluate };






