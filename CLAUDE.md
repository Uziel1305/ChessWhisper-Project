# Smart Chess Move — Project Notes

AI-assisted chess platform (project 43): native Android app (Java) + Node.js/Express game server + custom C++ engine service (UCI) + PostgreSQL.
Architecture documents: `ProjectArchitectureDocument-43.docx` (original), `Proposed-Architecture-SmartChessMove.docx` (revised proposal with diagrams).

## Core principle

The server is authoritative: it alone validates moves, runs the clocks, and decides results. The Android app is input and display only — it contains zero chess rules.

## Design decisions

### Legal-move hints come from the server (decided July 2026)

When the user taps a piece, the app highlights only the legal target squares — but the app does NOT compute legality:

- The server includes a `legalMoves` array (UCI strings, e.g. `["e2e4", "g1f3", ...]`) in every event that delivers a position: `match.found` / `game.state` and `move.committed`.
- `BoardView` filters that list by the tapped square to highlight targets and block everything else. Four entries with the same from/to squares (`e7e8q/r/b/n`) mean: show the promotion picker.
- No round trip on tap — the list arrives together with the position and only changes when a move commits.
- Legal moves are sent only for committed positions, so nothing leaks during the Tactical Retraction undo window.
- Rejected alternative: a client-side rules library (e.g. chesslib) for UX. Avoided so there is exactly one rules implementation (chess.js on the server) and client/server can never disagree.

### One server, one port for REST + WebSocket (decided July 2026)

The game server is a single Node.js process with a single HTTP listener serving both the Express REST API and the WebSocket hub — the WS handshake is an HTTP Upgrade on the same port:

- One address for the app: `https://host/api/...` (accounts, history, admin) and `wss://host/ws` (everything in-game).
- Socket auth happens at the upgrade step: the same JWT issued by REST login is verified before the handshake completes; connections without a valid token are rejected.
- REST routes read live in-memory state directly — e.g. `/api/admin/stats` reports active games straight from the Game Manager. No Redis or IPC layer.
- Process separation belongs at the engine boundary only (the C++ UCI pool behind its facade), so evaluation never blocks the game server's event loop.
- Rejected alternative: separate REST and WS server processes. Independent scaling isn't needed at the target load (≥100 concurrent games on one node), and it would force shared-state plumbing for anything REST needs from live games.

### The backend runs under Docker Compose (decided July 2026)

`docker compose up --build` at the repo root starts the complete backend; the host needs only Docker (plus Android Studio for the app). Three services on the default compose network:

- `db` — PostgreSQL with a named volume for persistence and a `pg_isready` healthcheck.
- `engine` — one multi-stage image: a build stage compiles the C++ UCI binary (cmake/gcc), the runtime stage runs the Node facade with the binary copied in (Stockfish can be baked in as the development stand-in). Internal-only — no published ports; the server reaches it at `http://engine:...`.
- `server` — waits for `db` healthy, runs migrations on startup, and is the only service with a published host port (that one port carries REST + WebSocket, per the one-server decision).
- The Android app is not a compose service — it connects to the server's published port from outside: `10.0.2.2:<port>` from the Android emulator, the PC's LAN IP from a physical phone. The base URL is a build config value in the app, never hardcoded.
- Configuration flows through compose `environment:` entries (`DATABASE_URL`, `JWT_SECRET`, `ENGINE_URL`, `PORT`) — the same variables `server/.env.example` documents, so the server runs identically with or without Docker.
- Repo impact: `docker-compose.yml` at the root; a `Dockerfile` + `.dockerignore` inside `server/` and `engine/`.
- Rejected alternative: installing Node, PostgreSQL and a C++ toolchain directly on each developer's machine. Compose gives both teammates an identical, reproducible backend with one command.
