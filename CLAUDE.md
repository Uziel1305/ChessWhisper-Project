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
- **The client must single-flight refresh.** Rotation plus reuse detection turns parallel
  401s into a forced logout: two requests that expire together (Home fires `/users/me` and
  `/games/history` at once) each call `/refresh` with the same token, the second is seen as
  a replay, and every token for the user is revoked. `ApiClient`'s authenticator therefore
  refreshes under one lock, and a thread that finds the stored access token already changed
  retries with it instead of refreshing again.
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
- Username and rating come from `GET /api/users/me`; the Games counter and the Recent games
  list come from `GET /api/games/history` (CW-214) — `{total, games}`, where each game is
  already seen from the caller's side (`color`, `opponent`, and a server-derived
  `outcome` of win/loss/draw, so the app never reads a PGN result). As planned, only the
  source changed, not the layout: the old hardcoded `0` and static "No games yet" became
  `gamesText` (a dash until history loads) and a `RecyclerView` with `historyEmpty` as its
  empty state.
- The two requests have separate states in `HomeViewModel`, so a failed history never
  hides a loaded profile. The counter is `gamesRepo.countFinishedByUser`, which reads
  `games` — not `rating_history` — so a finished game is listed and counted even if its
  rating row is missing.
- Home refreshes after a game through an `ActivityResultLauncher`: `GameActivity`
  `finish()`es back to the Home underneath (it used to start a new one, stacking a Home
  per game), and the result callback calls `refresh()`. `MATCHED` is consumed the moment
  the game is launched, so LiveData cannot replay it into a second launch. Nothing
  refreshes in `onResume()`, which would double every request on first open.
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
- The facade's pool (`engine/facade/src/pool.js`) therefore defaults to one worker per core
  (`os.availableParallelism()`); `ENGINE_WORKER_COUNT` overrides it. After every `bestmove`
  a worker is drained with `isready`/`readyok` before it takes another request, so output
  trailing one search can never be read as the next one's answer.
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
- Android chooses the mode with a picker on the home screen (CW-155), above Play. It
  hardcoded `mode: 'classic'` from CW-41 until the assist features existed to choose
  between. The picker offers **classic, eval and feedback only** — `retraction` is
  accepted by the server but deliberately not offered until its feature is built, since
  choosing it would give a game with no assist at all. `GameMode`
  (`android/.../ui/home/GameMode.java`) is the one place Android names the modes, with
  their wire values pinned by `GameModeTest`; the selection lives in `HomeViewModel`.
  Since CW-214 it includes `RETRACTION` too, so game history can label it, with
  `offeredInPicker = false` — the picker iterates `GameMode.pickerModes()`, never
  `values()`. An unknown future mode (`fromWire` returns null) shows its raw wire value.
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
### Move classification thresholds (decided September 2026)

A move's verdict comes from its centipawn loss, against these fixed thresholds:

| Verdict | cp loss |
|---|---|
| best | 0–10 |
| good | 11–50 |
| inaccuracy | 51–100 |
| mistake | 101–200 |
| blunder | 201+ |

- CW-87 asks for "the documented thresholds", but no earlier document (Jira, the repo, the
  architecture documents available to us) gave numbers. These were defined by the team when
  CW-87 was built, and this entry is now the documentation.
- Cp loss is the drop, from the mover's point of view, between the evaluation of the
  position they faced and the evaluation after their move, clamped at 0. Both evaluations
  are white-perspective centipawns, so white loses when the number falls and black when it
  rises. Mate scores are clamped to ±10000 by the engine facade, so walking into mate
  reads as a loss of about that size — a blunder.
- The table lives in one place: `THRESHOLDS` in `server/src/game/classification.js`. A
  change is a one-line edit there plus this entry, and `server/test/classification.test.js`
  pins every boundary on both sides.
- These are **engine-relative**: the same move can lose a slightly different number of
  centipawns under Stockfish and under the custom engine. CW-83's benchmark is where that
  is checked — known blunders and known good moves must get matching classifications from
  both — and is the one place these numbers may be revisited.
- **When both positions are a forced mate for the same side, the verdict comes from the mate
  distance instead** (decided October 2026). Every mate clamps to the same ±10000, so cp
  loss there is always 0 and mate-in-5 played into mate-in-8 used to read "best". `mateIn`
  counts full moves from the side to move, so under best play the attacker's move takes it
  down by exactly one and the defender's reply leaves it unchanged. The mover concedes
  whatever falls short of that, clamped at 0:

  | Moves conceded | Verdict |
  |---|---|
  | 0 | best |
  | 1–2 | good |
  | 3+ | inaccuracy |

  Never worse than inaccuracy: keeping a forced mate has not given the win away. No
  tolerance for engine jitter — a one-move wobble costs at most best→good, and skipping a
  mate in 1 for another mate in 1 is "good", not "best". The table is `MATE_THRESHOLDS`,
  beside `THRESHOLDS`, and `THRESHOLDS` stays the only cp table.
- **Every other case stays on cp loss, unchanged**: mate delivered (best — `mate 0` arrives
  as no `mateIn`, with `evalCp` pinned), mate let go, stalemate thrown, walking into mate,
  and a mate that changes hands (all blunder). The mate path needs both `mateIn` values
  non-null with the same sign.
- **On the mate path, `feedback.cp_loss` (and the wire's `cpLoss`) can be 0 while the
  classification is worse than best.** That column records the clamped cp difference, not
  the reason for the verdict, so it must never be read as "this move cost nothing".
- **Lost advantage** (decided October 2026): `move.feedback` carries `lostAdvantage: true`
  when, from the mover's side, the evaluation was at least `+LOST_ADVANTAGE_CP` (100)
  before the move and at most `-LOST_ADVANTAGE_CP` after it. One pawn is the conventional
  clear edge; the dead zone either side of 0 keeps engine noise around equality from firing
  it; and the ≥200 cp swing it implies means it only ever accompanies a mistake or a
  blunder. The constant sits beside `THRESHOLDS`. It needs the same two evaluations as the
  verdict, so a ply without a verdict (ply 1, or a failed engine call) never carries it.
- **Event-shape change.** `move.feedback` is `{type, ply, classification, cpLoss}` plus
  `lostAdvantage: true` only when true — absent otherwise, never `false`, the same
  convention as `mateIn`. Still sent to the mover only. Android shows "Lead slipped away"
  in place of the verdict label while keeping the verdict's colour and bars, and no longer
  displays `cpLoss` at all; it stays on the wire and in `feedback.cp_loss`.

### `eval.update` carries the mate distance as an optional `mateIn` (decided September 2026)

The facade clamps a UCI `score mate N` to ±10000 in `evalCp`, which throws the distance
away — so nothing downstream could ever show "mate in 3". `mateIn` carries the true
distance alongside `evalCp`, from the **same single evaluation** per committed half-move.
No extra engine call.

- **Same fixed White-perspective semantics as `evalCp`.** `mateIn: 3` means White mates in
  3; `mateIn: -3` means Black mates in 3. It is never flipped for the local player's colour
  or the board's orientation — flipping changes only where Android draws it.
- **Present only when the engine reports a forced mate ahead; otherwise the key is absent,
  not `null`.** An ordinary `eval.update` is still exactly `{type, ply, evalCp}`, and the
  facade's HTTP body is `{cp, bestMove}` — `mateIn` added only for a mate, `bestMove`
  absent only when the position has no legal move (CW-81). Inside the
  server, `engineClient.evaluate()` always resolves `{cp, mateIn}` with `null` for
  "none", so callers see one shape.
- **`mate 0` — the position is already checkmate — is absent too.** There is no mate
  ahead, and a zero distance cannot say who delivered it (JSON has no −0). `evalCp` still
  pins to the winner's end, and `game.end` announces the checkmate.
- **`evalCp` is unchanged, and `mateIn` now reaches classification too** (October 2026).
  `game.evals` still stores plain clamped centipawns; `game.mates` stores each ply's
  `mateIn` (or `null`) beside it, written in the same place so the two always cover the
  same plies. Classification reads it only when both neighbouring positions are a mate for
  the same side — see "Move classification thresholds". It is still RAM only, never
  persisted, and never sent in `move.feedback`.
- **No distance threshold on the wire.** The server reports whatever distance the engine
  found; showing an indicator only for `abs(mateIn) <= 5` is an Android display rule
  (CW-153). The bar itself needs no `mateIn` to pin to the right end — the clamped
  `evalCp` already saturates for any mate.
- The sign derivation lives in one place, `parseScoreLine` in `engine/facade/src/uci.js`,
  and `engine/facade/test/uci.test.js` pins all four combinations of (sign of UCI's `mate
  N`) × (side to move), plus `mate 0`.
- This changed an event's shape, so per the rule in the `moves` entry above it had to be
  told to whoever writes the client.

### The engine is built to compare evaluations and searches (decided September 2026)

The C++ engine is not one engine but a platform for several. Evaluation is an interface,
search features are independently switchable, and every combination is reachable from one
binary — so the contribution of each piece can be *measured* in fastchess rather than
asserted:

- **`Evaluator` is an abstract base class**; `MaterialEvaluator` and `PstEvaluator`
  implement it, and search takes a `const Evaluator&` chosen once before it starts. Search
  never learns which implementation it holds.
- **The reason it is an interface rather than a switch inside one `evaluate()` is the
  search signature**, not extensibility in the abstract. Adding an evaluator this way is a
  new subclass plus a line in `makeEvaluator`. With a free `evaluate(pos)` and a global
  selector, injecting one later would mean changing every search function and threading it
  down through the recursion — the one boundary that is genuinely expensive to move.
- **Virtual dispatch per leaf is not a concern here.** It is an indirect branch whose
  target never changes within a search, so it predicts perfectly; ~1-2ns against an
  evaluation of a few hundred. Stockfish avoids it because at 100M nodes/sec that becomes
  10% of wall clock — three orders of magnitude from where this engine operates.
- **Configurations are selected by UCI options on a single binary**, not by separate
  executables. Four evaluators against three independent search toggles is 32
  combinations; as binaries that is 32 CMake targets, of which Docker ships one and the
  other 31 exist only for experiments. As options it is 32 lines in a fastchess config,
  and that config file becomes the experiment record for the report.
- **Every option must be declared in the `uci` response.** GUIs reject options an engine
  never advertised, which is what turns a typo in a fastchess config into a startup error
  instead of a tournament quietly comparing an engine against itself. Each search also
  emits `info string eval <name>`, so the live configuration is in the logs.
- **`MaterialEvaluator` uses the piece bitboards (`count`) while `PstEvaluator` walks the
  64 squares (`pieceAt`)** — deliberately two implementations, not an oversight. The cheap
  evaluator's speed advantage is part of what is being measured: at equal time it converts
  saved work into extra depth, which is a real engine-design tradeoff rather than a
  confound to control for. The shared piece-value constants in `eval.cpp` are the contract
  that keeps the two consistent.
- **For ML evaluators later** (trained in Python, weights exported, inference written in
  C++): a new subclass owning its weights as constructor state, plus a string option for
  the weights path — the same shape Stockfish uses for `EvalFile`. Nothing in search
  changes. Not scheduled; the architecture just leaves the path clear.
- **Known limit of this interface:** it assumes evaluation is a pure function of the
  position. That fits a model evaluated at each leaf. It does *not* fit NNUE-style
  incremental evaluation, where an accumulator is updated inside make/unmake — that needs
  hooks into the move functions and a different interface shape. Accepted deliberately.
- Rejected alternative: a global `setEvaluator()` with a free `evaluate(pos)`. Simpler
  while there were two pure functions, but it is hidden mutable state, it makes evaluators
  awkward to construct in tests, and it postpones the one refactor that is costly.

### The evaluation model trains on a stored, canonical dataset (decided September 2026)

The multi-layer perceptron evaluator learns from a dataset of about 600,000 positions —
500,000 training, 50,000 validation, 50,000 held back as a frozen test set — built by the
Python pipeline in epic CW-158 and kept deliberately independent of whatever model consumes
it:

- **Every row carries `target_value` beside `raw_cp` and `raw_mate`.** `target_value` is
  centipawns; the raw fields are what the engine actually reported. Any training-time
  transformation — squashing to win/draw/loss space, clamping the tail — belongs to the
  training script, so it can change without regenerating a single row. Raw centipawns are a
  poor regression target directly, and **the measured reason changed when the training source
  did.** Against the evaluation dump it was the centipawn tail: median `|cp|` 80, p99 3,587,
  maximum 20,000, and 34.8% of the pool at three pawns or more. Against our own labels the
  centipawn distribution is far tighter — median 251 in training, p90 847, p99 1,325, maximum
  9,165, so 99% of rows sit inside 13 pawns — and it is the **mate band** that dominates
  instead: 4.7% of rows carry a target between 10,010 and 10,680, some 43 times the median. A
  10% error on a 10,600 target is 1,060 centipawns against 25 on the median, which squared is
  over 1,700 times the contribution. Either way the conclusion is the same: squashing to
  win/draw/loss space collapses everything past roughly 2,000 cp to one value, which is the
  right behaviour for an evaluation function. But that is the trainer's problem to solve, not
  the dataset's to pre-empt. All three splits measure the same, which is what sourcing them
  identically bought: mate 4.7 / 4.7 / 4.5%, median `|cp|` 251 / 240 / 238, p99 1,325 / 1,317 /
  1,316, depth p50 16 in every one.
- **`target_value` is from the side to move's point of view**, matching the `Evaluator`
  contract in `eval.hpp`. So `MlpEvaluator` returns its output unchanged and `uci.js` keeps
  doing the single flip to white that the eval bar and `classification.js` expect. Since every
  split is now labeled over UCI, which reports from the side to move, **no label is ever
  flipped** — `target_from_side_to_move` is the only entry point the pipeline uses. The Lichess
  evaluation dump is White-relative, established from the data rather than the documentation
  (CW-159): two independent tests over 200,000 records agree that `pvs[0]` is the maximum of its
  PV list for 100.0% of white-to-move records and 0.0% of black-to-move ones, and that the mean
  cp where White leads by ≥300 material is +1969 with White to move and +852 with Black to move.
  `target_from_white` and its tests stay for that reason — the dump is still the source of the
  frozen scale, and anything reading it must flip — but nothing in the current pipeline calls
  it. Getting this backwards would train the model to invert its own evaluation, and nothing
  downstream would flag it.
- **The evaluation dump's record shape, kept because the frozen constants came from it.** It is
  no longer a label source, but `MAX_CP` and `Y` are its measured maxima, so anything revisiting
  those numbers reads it again — and this is what it looks like. Each line is
  `{"fen", "evals": [{"pvs": [{"cp" | "mate", "line"}], "knodes", "depth"}]}`. `evals` is
  ordered deepest-first — 100.00% of the 1,023,606-row sample — but the label is selected by
  `max(depth)` anyway, because that is correct by construction rather than by an ordering that
  merely happens to hold. Within that eval the label is `pvs[0]`, the principal variation, and
  its `line` is discarded since only the score is wanted. `cp` is clamped by Lichess to
  ±20,000; 11.6% of records are exactly `cp: 0`; 12.4% carry a mate rather than a cp; the
  largest `|mate|` anywhere in the dump is 68 and none is 0; and **every key is unique** —
  0 duplicates in 1,023,606 — so duplicate rejection in the pipeline removes nothing.
- **Mate becomes `sign * (MAX_CP + MATE_STEP * (Y - |N| + 1))`** for a mate in N, with
  **`MAX_CP` 10,000, `Y` 68, `MATE_STEP` 10** — so mate in 1 is 10,680, mate in 3 is 10,660, and
  mate in 68 is 10,010, ten clear of the ceiling. `Y` and `MATE_STEP` are measured from the
  1,023,606-row uniform sample of the evaluation dump and have never moved.
- **`MAX_CP` was re-frozen once, from 20,000 to 10,000**, in October 2026, after all 600,000
  positions had been labeled by our own Stockfish and the dump had stopped being a label source.
  20,000 was Lichess's clamp, describing a source the dataset no longer uses. The measurement
  that replaced it: max `|cp|` across the complete dataset is **9,165**, and only **three rows in
  600,000** exceed 4,000 — all three exactly 9,165, in two independently sampled splits with a
  5,000-point empty gap beneath. An identical extreme in two independent samples is a structural
  ceiling in Stockfish 19's normalized cp output, not a sample maximum, which is what makes
  fitting to it defensible rather than overfitting to three rows. 10,000 is that ceiling rounded
  up: above it so nothing clamps, round enough to read as a decision, and close enough to halve
  the distance from the median row to the mate band (43× rather than 86×).
- **It does not move again for this dataset version**, and the reason to say so explicitly is
  that re-freezing cost 28,137 mate rows a recomputation and all three files a new checksum. A
  constant re-frozen twice is not frozen. Note what the change did *not* cost: nothing was
  re-searched, because `target_value` is derived from `raw_cp` and `raw_mate`, which is precisely
  why those columns exist.
- **Both entry points guard their input.** `mate_value` raises for `|N| > Y`; `_value` clamps
  `cp` into ±`MAX_CP`. The asymmetry of a defended entry beside an undefended one is the kind of
  silent failure CW-160 exists to close: before the clamp, the invariant that every mate target
  lies strictly outside the centipawn range depended on the engine never exceeding the ceiling,
  which is a property of Stockfish rather than anything the module enforced. Clamped rather than
  raising because a value past the ceiling means "winning beyond measure", and flattening it is
  the right reading, where raising would make the dataset unbuildable over a row whose exact
  magnitude the training transform discards anyway. `raw_cp` keeps what the engine actually said.
  It clamps nothing today: measured over all 600,000 labels, zero rows.
- **This replaced `sign * (30000 - 100 * N)`** once the dump had been inspected. That form put
  mate targets an order of magnitude above ordinary evaluations, and it placed mate in 1 at
  29,900 against `isMateScore`'s 29,936 threshold — 36 centipawns of clearance between a
  training target and the engine's own proven-mate band.
- **This puts three different mate encodings in the project.** They serve different jobs and
  are not being unified, so the table is the defence against confusing them:

  | Where | Encoding |
  |---|---|
  | Engine search (`search.hpp`) | `MATE_SCORE` 30000, one per **ply**: mated at ply p is `-MATE_SCORE + p` |
  | Facade output (`uci.js`) | clamped to ±10000, so the game server only ever sees a plain number |
  | Dataset `target_value` | from 10010 to 10680, ten per **move** closer to mate: mate in N is `10000 + 10 * (69 - N)` |

  The middle two are now numerically adjacent — the facade clamps at ±10000 and the dataset's
  centipawn ceiling *is* 10000 — which is coincidence, not design. They mean different things: the
  facade's 10000 is "a mate, distance discarded", the dataset's is "the largest centipawn value",
  with mates strictly above it.

- **`MlpEvaluator::evaluate` now sits nowhere near the engine's mate band, by construction.**
  `isMateScore` in `search.hpp` treats anything past `MATE_SCORE - MAX_PLY` — 29,936 — as a
  mate, and `search()` breaks out of iterative deepening when it sees one, so a net that
  overshot into that band on a position with no mate in it would make the engine stop
  deepening early and print `score mate N` with a meaningless N. Under the current target scale
  the largest value the model is ever trained toward is 10,680, so the clearance is over
  **19,000** rather than the 36 the old encoding left. A clamp is still worth having, because a
  regression head is not bounded by the range of its targets — **±15,000** on the current scale,
  comfortably above the 10,680 the model is trained toward and comfortably below 29,936 — but it
  is a guard rail, not the only thing standing between the evaluator and a broken search. Real
  mates still report correctly: they come from the terminal-position path, never the evaluator.
- **One label source: our own Stockfish, over positions sampled from games.** Training was
  originally to come from the public Lichess evaluation database, which is analysed to high
  depth and costs nothing to label. It was switched to games once the held-out splits had been
  labeled and the two distributions could be compared directly, and the measurement is what
  decided it: the dump carries **12.4%** mates against **4.6%** in positions sampled from real
  games, a median `|cp|` of **80** against **239**, and a 99th percentile of **3,587** against
  **1,317**. Three mismatches in three different directions, on a distribution the model would
  be evaluated against but never trained on.
- **What the switch bought, beyond one distribution.** Training positions come from games that
  `is_accepted()` bars from validation and test, so training is **game-disjoint** from both.
  That closes a residual the dump made unmeasurable: a dump position can be one ply from a test
  position — a near-duplicate no key-based blocklist can see — and the dump carries no game IDs
  with which to exclude it. Validation error also becomes directly comparable to training loss
  rather than merely correlated with it, and `target_from_white` leaves the pipeline's hot path
  entirely, taking its single most consequential sign convention with it.
- **The argument for the dump was label quality, and it loses on model capacity.** Its labels
  are searched to depth 46-95 against our depth 16, and deeper labels are closer to ground
  truth. But depth is not the binding constraint here — a 500,000-row MLP will not approach
  depth-16 Stockfish, let alone depth-50 — while the distribution mismatch affects every
  number in the report. The cost of switching was nine hours of unattended labeling at 15.4
  positions/second, plus CW-165's second pass and CW-166 rewritten. The dump work is not
  wasted: it produced `Y` and `MATE_STEP`, which every target still uses, and `MAX_CP`'s first
  value, which the complete dataset later replaced.
- **The pinned configuration *is* the label's scale, so it lives in code and is asserted.**
  `ml/scripts/engine.py` holds Stockfish 19, its SHA-256, `Threads 1`, `Hash 16`, `MultiPV 1`
  and `NODE_LIMIT` 110,000, and re-hashes the binary at every engine start — a different build
  would relabel positions on a different scale with nothing in the rows to show it. The
  embedded NNUE net is pinned by pinning the binary, which is how "the network is identical for
  every position" is satisfied by construction.
- **The budget is a node count, not a time limit, and that is what makes the labels
  reproducible.** CW-163 specified 200 ms; 200 ms was measured once on an idle core — median
  111,536 nodes over 286 positions — and frozen at 110,000. A time limit would make every label
  depend on machine load: this CPU has 4 physical cores behind 8 logical threads, so eight
  `Threads 1` engines each search roughly half of what one alone manages in 200 ms, and a laptop
  throttles over an hour at full load. Under a node limit the search is deterministic, so
  CW-163's "the result does not depend on how many ran at once" and "re-evaluating a sample
  reproduces the values already recorded" are provable rather than approximate — **200 positions
  re-evaluated by one engine reproduced `raw_cp`, `raw_mate`, `depth` and `nodes` exactly**,
  although the labels had been produced by four engines in a different order.
- **`ucinewgame` runs before every position**, and it is not optional. Without it the
  transposition table carries over, so a position's score depends on which positions preceded
  it — the work split would then silently change the labels, and both guarantees above would
  fail for a reason invisible in the output.
- **Validation and test are separated by game, not by position.** Consecutive positions in one
  game are nearly identical, so splitting at the position level leaks: the same middlegame
  would sit on both sides of the boundary and the held-out numbers would flatter the model. A
  game contributes to validation or to test, never both. Which one comes from a hash of the game
  ID under a **separate** personalisation from the one deciding whether the game is sampled at
  all: acceptance keeps 1 game in 64, which forces the accept digest's low bit to zero, so
  splitting on a bit of that same digest would have sent every game to one split and written one
  full file and one empty one without an error. Two `blake2b` personalisations, pinned by a test.
- **Within a game, positions are sampled at a randomised 4-6 ply spacing from a start in ply
  8-11, capped at ten per game by uniform subset.** The opening skip is because the first few
  plies repeat across enormous numbers of games and would appear in *both* splits, defeating the
  game-level separation; starting at 8 rather than 12 costs 0.80% of a split to cross-split
  transpositions (measured, against 0.14% at 12) and buys the opening coverage a held-out set
  needs. **The window's width is four rather than five so that the side to move comes out
  balanced by construction.** Two of 8-11 are even and two odd; a five-wide window is three and
  two, so 60% of games start with White to move, and since a step of 4 or 6 preserves the side to
  move and only 5 flips it, that bias decays as (1/3)^k instead of vanishing — measured, an 8-12
  window produced 51.1% White in both splits against 49.7% for 8-11. Getting it from the window
  costs nothing, where the alternative is deleting real positions after the fact — and under v1's
  absolute encoding the side to move is an input the network does see, so this is worth getting
  right at source rather than shrugging at. The cap is a **subset, not a truncation**: ten steps reach ply
  ~55 and roughly two-thirds of games run longer, so keeping the first ten would leave both
  splits without an endgame — the measured ply distribution runs p50 35, p90 75, max 217. A
  consequence is that the gaps in the written file are *sums* of 4-6, so verification regenerates
  each game's schedule and checks membership, which doubles as proof that the pass is reproducible
  from game IDs alone. Implemented in `ml/scripts/build_heldout_candidates.py`, checked by
  `measure_candidates.py`.
- **There is no longer a scale gap between the splits to account for**, which was the accepted
  cost of the original two-source design and the reason CW-168 existed. All three splits are
  labeled by one binary at one node budget, so a divergence between training loss and validation
  error can only be the model's doing. CW-168 shrinks to a much narrower check — comparing our
  labels against the dump's on the same positions — which is now curiosity about Stockfish
  depth rather than a correction the dataset depends on.
- **Deduplication keys on the three FEN fields the model can perceive** — piece placement, side
  to move, castling rights. Not the en-passant square, and not the halfmove clock or fullmove
  number. The rule is that the key mirrors the model's inputs: two positions the model cannot
  tell apart must never land on opposite sides of the train/test boundary, and two it can tell
  apart must not be collapsed into one. v1 takes castling rights as a feature and takes no
  en-passant feature, so that is where the line falls; a later version that adds en passant
  moves it. When key and encoding disagree, **coarsen** — a coarser key can only exclude *more*
  from training, which costs a little data and cannot cause leakage, while a finer key errs the
  other way.
- **Dropping en passant also removed a silent-divergence risk.** python-chess writes the square
  only when the capture is legal; `chess.hpp`'s default writes it whenever an enemy pawn is
  merely adjacent, without checking legality (`makeMove`'s `EXACT` template parameter adds that
  check, and we use the default); what the Lichess dump does is undocumented. Had any two of
  those disagreed, the same position would have produced two keys, the blocklist would have
  failed to match, and held-out positions would have leaked into training with nothing
  reporting it. None of that matters once the field is not keyed on — and a four-field FEN from
  the dump and a six-field one from python-chess now key identically with no special case.
  Implemented in `ml/scripts/canonical.py`, pinned by `ml/tests/test_canonical.py`.
- **Colour mirrors are not collapsed, and under the chosen encoding they should not be.** A
  position and its colour mirror have different keys, so both can be in the dataset. That was
  listed as an accepted residual while the input encoding was expected to be mover-relative,
  where the two would produce the *same* tensor. v1 encodes absolutely instead (CW-229), so they
  produce different tensors and are genuinely different inputs — the residual was never a
  problem, and the general rule holds either way: keying on the encoder's output would tie the
  dataset to the model architecture, which is precisely what this section exists to prevent.
- **A key that lands in both held-out splits is given to one of them, not deleted from both.** The
  winner is `blake2b(key, person=b"tiebreak") % 2`. Two different games reaching one position is a
  transposition, so the colliding keys are the *commonest* positions in chess, and dropping them
  everywhere would strip exactly those out of both held-out sets. Nothing leaks either way,
  because the blocklist is the union of the two splits, so training excludes the key whichever
  side keeps it. Measured: 711 collisions across 180,011 candidates, split 358/353. Duplicates
  *within* a split collapse to the record with the smallest `(game_id, ply)` — not the first seen,
  which would depend on the order the candidate file happens to be in, so a rebuild could swap
  which copy is in the split without changing anything visible.
- **The cut from ~88,900 survivors to exactly 50,000 per split is a hash rank**, not a random
  sample: `blake2b(key, person=b"select")` sorted, first 50,000. A rank because the count has to be
  exact where a modulus gives roughly n, and a hash for the reason CW-159 hashed rather than
  seeding an RNG — the outcome depends only on which keys exist, so it survives a rerun or a
  reordering. It is uniform in what the position contains, and that is checkable rather than
  asserted: taking 56% of the candidates moved side to move only from 49.7/50.3 to 49.6/50.4, and
  the two splits' ply spreads (22% under ply 20, 59% in 20-60, 19% past 60) agree to a tenth of a
  point. A rank correlated with game progress would have surfaced here as a split short of
  endgames. Implemented in `ml/scripts/select_heldout.py`, pinned by
  `ml/tests/test_select_heldout.py`.
- **The test set is frozen once evaluated**, with its checksum in the dataset metadata. It is not
  used for architecture, features, learning rate, epoch count, regularisation, preprocessing, or
  choosing between model versions — validation carries all of those. The pipeline enforces this
  structurally rather than by discipline: training is filtered against a blocklist that is the
  union of the validation and test keys, and no training code path opens the test file.
- **That blocklist is why the pipeline builds the held-out splits first.** It reads as a strange
  order — the smallest splits before the largest — but training cannot be filtered against
  something that does not exist yet.
- **The dataset holds only real positions** — nothing synthesised, duplicated or mirrored — and
  any rebalancing would have been by removing rows, never adding them. Mirroring in particular
  does not do what it looks like it does to the *sign* distribution: it maps a position to one
  carrying the **same** side-to-move target, because the mover's advantage travels with the
  mover. So it rebalances whose turn it is, not whether targets are positive or negative.
- **But under absolute encoding, mirroring is real augmentation, and that belongs to the
  trainer.** Mirror the board, swap piece colours and flip the side-to-move input, and v1's
  encoding (CW-229) produces a genuinely different tensor carrying an unchanged target — exactly
  doubling the training data at no cost in labeling. Under a mover-relative encoding the same
  operation is an identity function and worth nothing, which is the version of this argument the
  earlier entries here were written against. It stays out of the **dataset** either way: "any
  training-time transformation belongs to the training script" covers augmentation too, and a
  mirrored row in the dataset would be a synthetic position masquerading as a sampled one.
- **In the event, no split needed rebalancing at all**, and the 500,000 is a uniform hash-ranked
  draw. Side to move came out 49.8 / 50.2 in training against 49.6 / 50.4 and 49.4 / 50.6 in the
  held-out splits — fractions of a percentage point, so deleting real rows to correct them would
  trade data for nothing measurable. The ply spreads agree to within a percentage point across all three
  splits (21.0 / 59.4 / 19.7 for training against 22.1 / 58.8 / 19.1 and 22.2 / 58.6 / 19.3),
  which is the one-distribution claim showing up as a measurement rather than an intention. And
  the magnitude problem that thinning mates was meant to address is the target transform's to
  solve: it costs no rows and can be revised without regenerating any.
- Rejected alternative: **using the evaluation database for training**, which is what the epic
  was originally built around. It removes a nine-hour labeling run and supplies labels searched
  three to five times deeper. Rejected on the measurements above — three distribution mismatches
  against the set the model is scored on, no game IDs with which to exclude near-duplicates of
  held-out positions, and a depth advantage the model has nowhere near the capacity to use.
