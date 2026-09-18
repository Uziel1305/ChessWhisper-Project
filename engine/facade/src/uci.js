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

module.exports = { handshake };






