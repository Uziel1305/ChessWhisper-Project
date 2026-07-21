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

### Short-lived access JWT + rotating, hashed refresh tokens (decided July 2026)

Login issues two tokens instead of one: a short-lived access JWT (15 min) that the
auth middleware verifies locally on every request, and an opaque, long-lived refresh
token (30 days) used only to silently obtain a new access token from
`POST /api/auth/refresh`.

- The refresh token itself is never stored — only its SHA-256 hash, in a new
  `refresh_tokens` table (mirrors the password_hash principle: no usable secret at
  rest). SHA-256, not bcrypt: the token is a 256-bit random value, not a low-entropy
  user secret, so a fast deterministic hash is safe and — unlike a salted bcrypt
  digest — can be indexed for O(1) lookup.
- Every refresh rotates the token: the presented one is revoked and a new one takes
  its place (`replaced_by_id` links the chain, `family_id` groups it). If an
  already-revoked refresh token is ever presented again, every refresh token for
  that user is revoked, forcing full re-login everywhere — the cheapest strong
  signal available that a token was stolen and replayed.
- `POST /api/auth/logout` revokes only the current device's refresh token, not every
  session — logout-everywhere is a trivial follow-on (`revokeAllForUser`) if ever
  needed, not built now.
- Android never validates or decodes either token: it stores both
  (EncryptedSharedPreferences), sends the access token on API calls, and calls
  `/api/auth/refresh` on a 401 — consistent with the app carrying zero business logic.
- The access JWT is the same one the WebSocket upgrade step verifies (per the
  one-server decision above) — refresh tokens are REST-only and never touch the WS
  handshake.
- Rejected alternative: a single long-lived JWT for "stay logged in" (the original
  plan). A stateless JWT can't be revoked before it expires, so logout or a stolen
  device would leave it valid for its full lifetime; the refresh-token table gives
  the server a place to kill access immediately.
