const { handshake } = require('./uci');

handshake()
    .then((child) => {
        console.log('engine handshake ok');
        child.kill();
    })
    .catch((err) => {
        console.error('engine handshake failed:', err);
        process.exit(1);
    });