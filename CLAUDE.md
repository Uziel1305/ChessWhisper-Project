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

### `MainActivity` is the login screen (decided August 2026)

The launcher activity is the login screen itself — not a dedicated router activity and
not the home screen:

- `MainActivity.onCreate()` checks for a stored session (the tokens in
  EncryptedSharedPreferences, per the refresh-token decision above) before inflating
  the login form. If a session exists it starts the home activity and `finish()`es,
  which is what CW-11 requires: reopening the app goes straight to the home screen.
- Registration lives in its own `RegisterActivity`, reached from a "Don't have an
  account? Register" link on the login screen. It is never the launcher — the app's
  entry point is always login-or-home.
- The home screen (CW-12, profile + rating) is therefore a separate activity, not
  `MainActivity`.
- Keeps the activity count low and reuses the template's
  `windowSoftInputMode="adjustResize"` already set on `MainActivity`, which is exactly
  what a credentials form wants.
- Rejected alternative: a thin no-UI router activity as the launcher that dispatches to
  Login or Home. Cleaner separation on paper, but it adds a third activity to carry what
  is a four-line branch in `onCreate()`.

### The home screen is laid out for what it becomes (decided August 2026)

The home screen carries more views than CW-12 needs, because it is the hub every later
story hangs off and re-laying it out each time is worse than drawing the shell once:

- Top to bottom: a large top app bar on `colorPrimaryContainer` ("Signed in as" above the
  username), a two-tile stat strip (Rating | Games), a "Recent games" section, and a Play
  button pinned at the bottom.
- Only **username and rating** come from `GET /api/users/me`. Games shows a hardcoded `0`
  and the history section a "No games yet" empty state — both *literally true* today,
  since no game can be played yet, so they read as real empty states rather than
  placeholders. When the games story lands only the source changes, not the layout.
- The hardcoded `0` silently becomes wrong the day games are recorded and nothing will
  fail, so `gamesText` and `historyEmpty` carry a comment naming the ticket that replaces
  them.
- **Play is `enabled="false"`** until a matchmaking activity exists. A live button with no
  click listener reads as broken; a disabled one reads as not built yet.
- The app bar bleeds to the screen edges, so it needs negative horizontal margins to
  escape the 24dp `R.dimen.screen_padding` that the insets listener applies to the root
  (`setPadding` replaces rather than adds — same reason `RegisterActivity` applies its
  padding in code).
- App bar and stat strip start `GONE` and appear only on success, so the header never
  flashes blank while the request is in flight.
- Rejected alternatives: a centered layout mirroring `activity_register.xml`, and a
  `MaterialCardView` profile card. Both look better with only two fields on screen, but
  both need rebuilding once Play and History arrive, and the card would introduce the
  project's first card component for one screen.

### `GET /api/users/me` answers 404 for a deleted user (decided August 2026)

A valid access token whose `sub` names a row that no longer exists returns
`404 { error: 'user_not_found' }`, not 401:

- `requireAuth` never produces a 404 — it only returns 401, in three branches
  (missing/malformed header, `TokenExpiredError` → `access_token_expired`, and any other
  verify failure). The 404 comes from the route handler's `if (!user)` guard after
  `usersRepo.findById` returns `undefined`.
- 401 would be wrong: the signature is genuine and unexpired, so nothing is wrong with the
  token. The client's correct reaction differs too — a 401 means "refresh or re-login", a
  404 means "this account is gone, nothing will fix it".
- Without the guard, `user.username` on `undefined` throws, Express 5 catches the async
  rejection, and the caller gets a default HTML 500 with no envelope — a silent failure.
- `server/test/users.test.js` asserts this. The decision appears in no ticket text, so
  that test is its only record in the repo.

### Time control is a constructor argument, never a literal (decided August 2026)

Support for 3/5/10-minute games is built into the first version of the clock, even though
choosing a time control is a later story:

- `clock.js` takes its starting duration as a constructor argument. There is no `600000`
  literal anywhere in the file; the value travels from the queue key into the game.
- `games.time_control_ms` exists from `002_games.sql`, so every stored game records what it
  was played at.
- `queue.join` carries `{mode, timeControl}` from its first version — the payload the
  architecture document already specifies. Building it without `timeControl` would mean
  knowingly shipping a protocol that has to change on both the server and the Android client.
- The matchmaking queue is keyed by `(mode, timeControl)` so a 3-minute player is never
  paired with a 10-minute one. The **picker UI** is deliberately deferred: it is cheap
  whenever it is built, and before rating-based matchmaking exists there is nobody waiting at
  the other time controls anyway.
- Rejected alternative: hardcode 10 minutes now and add the other controls later. The feature
  is worth almost nothing on its own, but retrofitting it reopens the clock, the queue, the
  schema and the UI at once — an expensive change bought for a cheap feature.

### The custom engine is built behind a Stockfish scaffold (decided August 2026)

The eval bar and instant-feedback modes are wired to Stockfish behind the engine facade while
the custom C++ engine is still being written, and the engine is swapped in at the end:

- Both features need *an* evaluation, not a *good* one — the bar renders a number and
  classification derives cp-loss from consecutive evaluations. Neither depends on engine
  strength, so neither should wait on engine progress.
- Without this, the two features sit behind the project's single biggest unknown (perft
  debugging on hand-written move generation). With it, they are finished and demoable weeks
  before the engine is, and a slipping engine costs evaluation *quality* rather than features.
- The swap is a one-line facade config change, and Stockfish stays in the repo afterwards as
  the benchmark that validates the custom engine's evaluations against a known-good reference.
- **Stockfish is never the deliverable.** The shipped product runs the custom engine — this is
  what `ProjectArchitectureDocument-43.docx` Objective 2 requires ("custom AI-based chess
  engines"), and §6 of the proposal already sanctions the stand-in-plus-benchmark pattern.
- Rejected alternative: block the eval bar and feedback on the custom engine being finished.
  It puts two of the four highest-priority features behind the riskiest work in the project,
  with no fallback if the engine runs late.

### Engine capacity, not the game server, limits concurrent games (decided August 2026)

The ≥100-concurrent-games target is an engine-pool question:

- The Node server is not the constraint. Games are idle almost all the time, chess.js
  validation is microseconds, per-game state is a few KB, and 100 games is 200 sockets.
- The engine is: a 200 ms budget with one worker per core gives ~5 evaluations/sec/core, and
  100 concurrent 10-minute games need ~13/sec. Four cores fits with headroom; two does not.
- Therefore **one evaluation per committed half-move, never continuous** — and that single
  evaluation serves both the bar and the classification. Evaluating twice halves capacity.
- `clock.js` computes remaining time from timestamps with one `setTimeout` per game for the
  flag deadline, rather than a `setInterval` tick per game — at 100 games the latter is ~1000
  wakeups a second computing values nobody reads.
