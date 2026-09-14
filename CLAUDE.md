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

### `LoginActivity` is the launcher (decided August 2026)

The launcher activity is the login screen itself — not a dedicated router activity and
not the home screen:

- `LoginActivity.onCreate()` checks for a stored session (the tokens in
  EncryptedSharedPreferences, per the refresh-token decision above) before inflating
  the login form. If a session exists it starts the home activity and `finish()`es,
  which is what CW-11 requires: reopening the app goes straight to the home screen.
- A stored refresh token is not by itself proof of a live session, so the check confirms
  it against `/api/auth/refresh` rather than trusting local state. A network failure
  during that check offers Retry rather than the login form — the session may well still
  be valid, and making the user re-enter credentials over a connectivity blip is wrong.
- Registration lives in its own `RegisterActivity`, reached from a "Don't have an
  account? Register" link on the login screen. It is never the launcher — the app's
  entry point is always login-or-home.
- The home screen (CW-12, profile + rating) is therefore a separate activity, not the
  launcher.
- Each screen lives in its own `ui/` subpackage — `ui.login`, `ui.home`, `ui.register` —
  with its Activity and ViewModel together. Only `SessionAwareActivity` sits directly in
  `ui`, since it belongs to no single screen. It is `abstract` and must **not** be
  declared in the manifest.
- Keeps the activity count low and reuses the template's
  `windowSoftInputMode="adjustResize"`, which is exactly what a credentials form wants.
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
- Without this, the two features sit behind the engine's own timeline. With it, they are
  finished and demoable weeks before the engine is, and a slipping engine costs evaluation
  *quality* rather than features. (Originally this guarded against perft debugging on
  hand-written move generation, then the project's single biggest unknown. That specific risk
  was removed in September 2026 — see the entry below — but the scaffold still earns its
  place, because evaluation and search remain unwritten.)
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

### One writer for the `Authorization` header (decided August 2026)

`ApiClient`'s OkHttp interceptor is the only code in the app that sets `Authorization`.
No Retrofit interface declares a `@Header("Authorization")` parameter, and no repository,
ViewModel or Activity handles a token:

- `UserApi.me()` takes no arguments. The interceptor reads the access token from
  `SessionManager` and attaches it to every outgoing request, including `/register`,
  `/login` and `/refresh` — none of those read the header, and excluding them would mean
  maintaining a path list.
- Two writers is worse than it looks: the interceptor uses `.header()`, which *replaces*
  rather than appends, so an explicitly-passed token is silently discarded whenever a
  session exists. The bug is invisible until there is no session, which is exactly when
  testing is least likely to catch it.
- CW-12 was built before the interceptor existed and did pass the header explicitly, so
  the two stories could be developed in parallel without a compile-time dependency. That
  parameter was removed in the same commit that adopted the interceptor.
- Consequence for every future screen: a 401 reaching a repository's `onResponse` means
  the authenticator already tried refreshing and failed. There is nothing left for the
  calling layer to do about tokens.

### A dead session is broadcast, not detected per screen (decided August 2026)

When a refresh fails, `SessionManager` announces it and screens react — no screen inspects
error codes to work out that it has been logged out:

- `SessionManager` exposes `sessionEnded` as `LiveData`. `clearSession()` sets it true,
  `saveSession()` sets it back to false. **`postValue`, not `setValue`** — `clearSession()`
  is called from `ApiClient`'s authenticator, which runs on an OkHttp thread.
- The reset in `saveSession()` is not optional: `LiveData` replays its current value to
  every new observer, so a permanently-true flag would bounce the next screen straight
  back to login, forever.
- `SessionAwareActivity` is the base class for every screen that needs a session. It
  observes the flag and navigates to `LoginActivity` with
  `FLAG_ACTIVITY_NEW_TASK | FLAG_ACTIVITY_CLEAR_TASK`, so "back" cannot walk into a screen
  whose session just died. `LoginActivity` and `RegisterActivity` deliberately do **not**
  extend it — the first is the destination, the second needs no session.
- Why not check the error code instead: the 401 that surfaces is the *original* request's,
  so its message says "access token expired" when the real cause was a dead refresh token.
  It describes step one of a story that ended somewhere else.
- `HomeActivity.render()` additionally returns early when `hasSession()` is false. Both the
  session signal and the Retrofit callback are posted to the main thread, and while the
  signal is normally posted first, `finish()` is not synchronous — so the error branch can
  still run and flash a misleading message. `apply()` updates SharedPreferences' in-memory
  map synchronously, which makes `hasSession()` a reliable check where the ordering is not.
- In practice this fires rarely today: `LoginActivity` re-checks the session on every cold
  start, so a dead session is usually caught before the home screen is created. The base
  class is a safety net for screens that make requests after startup.

### Unexpected server failures still return Express's default 500 (deferred August 2026)

The server has no error-handling middleware. An unexpected throw in a route produces
Express 5's default **HTML** 500, not the project's `{error, message}` envelope:

- `auth.routes.js` catches only `DuplicateUsernameError` and re-throws everything else;
  `users.routes.js` catches nothing. Both rely on this default.
- On Android this is survivable but lossy: `ApiErrors.from` cannot parse an HTML body, so
  the user sees the generic "Something went wrong. Please try again." rather than anything
  specific. `ApiErrors` catches `JsonSyntaxException` as well as `IOException` precisely
  because of this — Gson throws a `RuntimeException` on HTML, which the original
  `AuthRepository.parseError` did not catch.
- The fix is one middleware in `app.js` after the route mounts, about six lines, and it
  would cover every route at once. Deliberately deferred rather than solved with a
  `try/catch` per route, which would duplicate endlessly and make one handler behave
  differently from its neighbours.
- Known cost: a `TypeError` in a handler surfaces as a bodiless 500 whose real message is
  only visible via `docker compose logs server`.

### `mode` names the assist features, not a rating category (decided August 2026)

Every game is rated. `mode` — carried by `queue.join`, stored in `games.mode` — says which
AI-assist features are switched on for that game:

- The vocabulary is `classic` (no assistance), `eval` (evaluation bar), `feedback`
  (instant move classification) and `retraction` (Tactical Retraction undo window). The
  set **grows** as assist features land; it is deliberately not closed.
- It is half the matchmaking key `(mode, timeControl)` for a sharper reason than the time
  control is: both players must agree. A player with an eval bar facing one without is not
  playing a variant, they have an unfair advantage — so the queue must never pair them.
- **No `CHECK` constraint on `games.mode`**, for the same reason `games.reason` has none:
  a closed constraint turns every new assist feature into a schema migration.
- The wire values are deliberately short. `games.mode` is `VARCHAR(16)` and the natural
  long forms overflow it — `instant_feedback` is exactly 16, `tactical_retraction` is 19.
  They also travel on every `queue.join`, so brevity costs nothing and buys headroom.
- `queue.join` must **reject** an unrecognised mode rather than key a waiting list by it.
  A typo would otherwise leave a player queued alone forever, with no error to explain it.
- Android hardcodes `mode: 'classic'` from CW-41. A picker is deferred exactly as the
  time-control picker is: cheap to build once the assist features exist, worthless before.
- Rejected alternative: `mode` as `rated`/`casual`. Nothing in this product is unrated, so
  the field would have carried no information, and the assist features would then have
  needed a second field anyway.

### The `moves` table stores UCI only, not the resulting position (decided September 2026)

`003_moves.sql` is `id, game_id, ply, uci, created_at`. There is deliberately **no
`fen_after` column**, though CW-43's original description specified one:

- Every position is derivable by replaying `uci` from the start. Storing it would be a
  second source of truth for a fact the move list already carries, and if the two ever
  disagreed nothing would say which was wrong.
- The only consumer would be a game-history endpoint reading past games back. That is not
  in CW-28, not on the critical path, and when it lands it can replay through the chess.js
  the server already loads. The accepted cost of this decision is that doing so puts a
  rules engine into the REST path for the first time — every other route is a thin read.
- Rejected reasons for keeping it: **O(1) jump to an arbitrary ply** — the history UI steps
  move by move and never random-accesses, so there is nothing to speed up; and **feeding
  the evaluation feature** — evaluation runs live, once per committed half-move, with the
  FEN already in hand, and never reads a stored one back.
- `UNIQUE (game_id, ply)` is what actually protects the record: a move submitted twice, by
  a client retry or a race, fails on the constraint rather than silently writing a
  duplicate ply. Same principle as `users.username` — let the constraint decide.
- If it is ever wanted: `ALTER TABLE moves ADD COLUMN fen_after TEXT`, leaving old rows
  null. A history feature that shows nothing for games played before it existed is a fine
  trade against a backfill script that replays every stored game.
- **This is a storage-only change, so it crosses no seam with Android.** `match.found.fen`
  and `move.committed.fen` are computed live by `Game.js` and are unaffected. The general
  rule it illustrates: a storage-only change belongs to the server alone, while any change
  to an event's *shape* has to be told to whoever is writing the client.

### The engine's rules come from a library; its evaluation and search are ours (decided September 2026)

The C++ engine vendors [Disservin/chess-library](https://github.com/Disservin/chess-library)
for board representation, FEN handling and legal move generation. `eval.cpp` and `search.cpp`
are written from scratch. The original plan — hand-written move generation, CW-79 — was
deleted, and CW-78 rewritten as a library integration:

- **The same rule the server already follows: rules → library, evaluation → ours.** The Node
  server has always used chess.js rather than implementing the rules; extending that to the
  engine is consistency, not a retreat.
- **`ProjectArchitectureDocument-43.docx` Objective 2 asks for a custom AI-based engine, and
  this still delivers one.** Move generation is not AI — it is deterministic, has exactly one
  correct answer, and is verifiable against published perft counts. The AI is the evaluation
  function and the search: material weights, piece-square tables, negamax, alpha-beta,
  iterative deepening, quiescence and MVV-LVA ordering (CW-115 → CW-121) are all still ours.
- **What it bought:** hand-written movegen plus perft debugging was assessed as the project's
  largest schedule risk and the one coin-flip in it. Removing it costs nothing the project is
  graded on and returns days to the part that is.
- **Two rules implementations now exist, with different jobs.** chess.js on the server is
  *authoritative* — it validates every player move. `chess.hpp` in the engine never sees a
  player's move; it only feeds the search, which generates and unmakes positions internally.
  They cannot disagree about a live game because only one of them is ever asked.
- **The library sits behind our own wrapper** (CW-95), so evaluation and search never call it
  directly. That keeps it swappable and keeps the engine's own code legible as ours.
- **Perft (CW-80) still runs**, but as verification of the integration rather than debugging of
  our own generator. It still catches real wrapper bugs — wrong side to move, a castling right
  dropped in translation, a promotion that produces three moves instead of four.
- **Pinned to a commit SHA, not a tag** (`53e6a841dcda7059a2af363d85f785ef1817304a`), because
  the project publishes no releases. MIT licensed, with its `LICENSE` vendored alongside the
  header in `engine/cpp/third_party/`.
- Rejected alternative: hand-writing move generation anyway, for its own sake. It is genuinely
  educational, and in a term with slack it would be the better exercise — but it consumes the
  riskiest days in the schedule to produce something a library already does correctly, while
  the parts that actually demonstrate the project's thesis go unwritten.
