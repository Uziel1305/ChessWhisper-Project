// Process entry point: the only place that binds a port. app.js stays
// listen-free so the tests can import it without starting a real server.
const app = require('./app');
const http = require('http');
const runMigrations = require('./db/migrate');
const { attachHub } = require('./ws/hub');

// Comes from compose. The same port carries REST and, later, the WebSocket hub.
const PORT = process.env.PORT;

// Migrations gate startup: the schema is guaranteed to be current before the
// first request can arrive. depends_on/service_healthy in compose has already
// waited for Postgres to accept connections by this point.
runMigrations()
  .then(() => {
      const server=http.createServer(app);
      attachHub(server);
      server.listen(PORT,()=> {
        console.log(`Server listening on port ${PORT}`);
      })
  })
  .catch((err) => {
    // Fail loudly rather than serving against a broken or half-built schema.
    // A container that exits is far easier to diagnose than one returning 500s.
    console.error('Migrations failed, not starting server:', err);
    process.exit(1);
  });

