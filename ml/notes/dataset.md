# Dataset notes — CW-159

How the two Lichess dumps were obtained, what is in them, and the constants frozen from
them. `eval_sample_report.txt` beside this file holds the raw measurement output.

---

## The two dumps

| | |
|---|---|
| `lichess_db_eval.jsonl.zst` | 22.09 GB, 409,710,113 positions, downloaded 2026-09-28 |
| `lichess_db_standard_rated_2015-04.pgn.zst` | 302.52 MB, downloaded 2026-09-28 |

- Evaluations: `https://database.lichess.org/lichess_db_eval.jsonl.zst`
- Games: `https://database.lichess.org/standard/lichess_db_standard_rated_2015-04.pgn.zst`
- Checksums: `https://database.lichess.org/standard/sha256sums.txt`

Both live in `ml/data/`, which is gitignored. They are reproducible from the URLs above plus
the parameters recorded below, which is what makes ignoring them lossless.

### Integrity

The games month was verified against `sha256sums.txt` and matched. Worth knowing why that
mattered: an interrupted download that `curl -C -` resumed produced a file that *looked*
complete, and only the hash could say whether the resumed bytes were real data or a server
error body. They were real.

The evaluation dump has no published checksum — the `sha256sums.txt` manifests sit under the
per-variant game directories, and this file is at the site root. Its integrity is established
differently and more strongly: the sampling pass read all **409,710,113** records and reached
a clean end of stream. A truncated or corrupted zstd file cannot do that, and the record count
matches Lichess's published figure exactly, so every byte was decompressed and parsed.

### Why 2015-04

Validation and test need about 21,000 games between them — 90,000 candidates each at the 8.6
positions per game the sampling rule actually yields. Every month from 2014 onward carries
hundreds of thousands, so file size past that point is cost with no benefit — a 2017 month is
6.55 GB for the same 21,000 games. 2015-04 is the earliest month comfortably above a million:
it holds 1,785,417, which is 85 times what the splits consume, with a normal rating spread and
an end-to-end stream in minutes.

Validation and test both come from this one month, split by game so no game contributes to
both.

---

## Record shape of the evaluation dump

```
{"fen": "<4-field FEN>",
 "evals": [ {"pvs": [ {"cp": N | "mate": N, "line": "<uci>"}, ... ],
             "knodes": N, "depth": N}, ... ]}
```

- **`fen` is four fields** — placement, side to move, castling, en passant. No clocks. That is
  exactly the deduplication key the pipeline uses, so both label sources normalise identically
  with no special case.
- **`evals` is a list**, ordered deepest-first (100.00% of the sample). Fewer PVs means greater
  depth, since a 2-line search goes deeper than a 5-line one for the same work. The label is
  still selected by `max(depth)` rather than by taking `evals[0]` — correct by construction
  rather than by an ordering that merely happens to hold.
- **The label is `pvs[0]`** of that eval — the principal variation, i.e. the engine's chosen
  move. Its `line` is discarded; only the score is wanted.
- `cp` and `mate` are alternatives within a PV. `depth` and `knodes` belong to the eval, not
  the PV.

---

## Scores are from White's point of view

Established from the data, not from the documentation, which does not say. Two independent
tests over 200,000 records, both agreeing:

**Multi-PV ordering.** Multi-PV is always listed best-first for the side to move. Where Black
is to move, `pvs[0]` is the **minimum** of its PV list in 100% of cases (35,816 of 35,829);
where White is to move it is the **maximum** (39,932 of 39,943). Lower being better for Black
means higher is better for White.

**Material.** Mean `cp` in positions where White leads by ≥300 material is **+1969** with White
to move and **+852** with Black to move. Both strongly positive; a side-to-move convention
would have made the second strongly negative.

### The consequence

```python
white_cp = pv["cp"] if "cp" in pv else mate_value(pv["mate"])
target_value = white_cp if side_to_move == "w" else -white_cp
```

**Training labels from this dump are flipped when Black is to move. Validation and test labels,
which we generate ourselves over UCI, are already from the side to move and are not flipped** —
UCI defines `score cp` that way and both Stockfish and our own engine follow it. Getting this
backwards would train the model to invert its own evaluation, and nothing downstream would
flag it.

---

## The derived candidate pool

`ml/data/eval_sample.jsonl.zst` — 1,023,606 records, 75 MB, built in 23.9 minutes by
`ml/scripts/build_sample.py`.

| | |
|---|---|
| selection | keep when `blake2b(fen, digest_size=8) % 400 == 0` |
| yield | 1,023,606 of 409,710,113 (0.2498%, against 1/400 = 0.2500%) |
| records with no `fen` | 0 |

**Hash of the FEN rather than a seeded RNG**, so the sample is deterministic, resumable and
independent of the order records arrive in — a pass that dies four hours in restarts and
produces the identical sample. It keys on the same four-field FEN used for deduplication, so
the sample is stable even if the dump is re-released with records reordered.

**Whole lines are stored, unparsed and unfiltered.** Which eval and which PV becomes the label
is a decision the inspection was meant to inform, not to pre-empt; keeping the original line
means revisiting it costs seconds against 75 MB instead of half an hour against 22 GB.

**The pass never calls `json.loads`.** The FEN is sliced out with `line.find(b'"fen":"')` and
only the ~1M kept lines are ever decoded. Building 409 million Python dicts to discard
409,709,000 of them is the difference between 24 minutes and most of a day.

---

## Frozen constants

```
MAX_CP    = 20000     # max |cp| — Lichess's own clamp, exactly symmetric
Y         = 68        # max |mate| across the whole dump
MATE_STEP = 10
```

```python
mate_value(N) = sign(N) * (MAX_CP + MATE_STEP * (Y - abs(N) + 1))
```

Mate in 1 → 20,680. Mate in 68 → 20,010, ten clear of the largest centipawn value. Strictly
ordered by distance to mate, every value strictly outside the centipawn range.

These are **frozen and never recomputed at use.** A regenerated pool with a different `Y` would
silently change what every previously written target means. The conversion asserts
`|N| <= Y` and fails loudly, because a record from outside the pool the constants came from
would otherwise encode to a value inside the centipawn range, or with an inverted sign.

No record has `|mate| == 0` or `|mate| >= 100`, so neither edge case arises.

---

## What the pool looks like

| | |
|---|---|
| distinct keys | 1,023,606 — **zero duplicates** |
| side to move | 51.0% White, 49.0% Black |
| score kind | 87.6% `cp`, 12.4% `mate` |
| exactly zero | 11.6% |
| `\|cp\|` percentiles | p50 80, p75 308, p90 562, p99 3,587, max 20,000 |
| magnitude buckets | <0.5 pawns 35.4% · 0.5–1.5 18.7% · 1.5–3 11.1% · 3–6 15.1% · >6 7.3% · mate 12.4% |

**No rebalancing was applied.** The 500,000 training set is a uniform draw from this pool.

- **Side to move.** 51.0/49.0 is one percentage point, and it is invisible to a model whose
  input is encoded from the mover's point of view. Deleting 21,424 real rows would correct
  something the network cannot perceive.
- **Mate frequency.** 12.4%, not the 18.4% the dump's first 200,000 records suggested. That
  contiguous slice was unrepresentative in other ways too — it showed 53% single-eval records
  against a true 91.6% — which is the whole argument for measuring on a uniform sample.
- **Magnitude.** A third of the pool sits at three pawns or more. A 10% error on a 20,000
  target is 2,000 centipawns against 8 on the median 80 — squared, 62,500 times the
  contribution. Thinning mates would not touch that; the target transform in the training
  script is what addresses it, and it costs no rows.

Any correction, had one been warranted, would have been **undersampling only** — real positions
removed, nothing synthesised, duplicated or mirrored. Mirroring specifically does not help: it
maps a position to one carrying the *same* side-to-move target, because the mover's advantage
travels with the mover, so it rebalances whose turn it is rather than the sign distribution.
Colour symmetry, which is what it looks like it buys, belongs in the input encoding.

---

## The held-out candidates — CW-161

`ml/data/val_candidates.jsonl.zst` (90,009 records) and `test_candidates.jsonl.zst` (90,002),
1.9 MB each, built in 2.5 minutes by `ml/scripts/build_heldout_candidates.py`. A record is
`{"fen", "game_id", "ply"}`, the FEN in full six fields because Stockfish wants the halfmove
clock. Candidates, not splits: CW-162 deduplicates and selects, CW-163 labels, CW-164 freezes.

| | |
|---|---|
| games traversed | 1,386,295 of 1,785,417 (78% of the month) |
| games used | 20,801 — 1.2% of the month |
| game accepted when | `blake2b(game_id, person=b"accept") % 64 == 0` |
| split | `blake2b(game_id, person=b"split") % 2` — a **separate** digest |
| positions per game | first at ply 8–11, then +4, +5 or +6, capped at 10 |
| yield | 8.64 per game (val, 10,423 games), 8.67 (test, 10,378) |
| ply spread | p25 20, p50 35, p75 54, p90 75, p99 117, max 217 |
| side to move | 49.7% White / 50.3% Black, both splits |
| duplicate keys within a split | 784 (0.87%) val, 759 (0.84%) test |
| keys present in both splits | 711 (0.80%) |

**Two personalised hashes, not one digest read twice.** Acceptance requires `v % 64 == 0`,
which forces `v % 2 == 0` — so taking the split from the same digest's low bit would have put
every accepted game in one split and left the other empty, and the run would have completed
and written one full file and one empty one with no error anywhere. `test_heldout_sampling.py`
pins that both splits are populated.

**The whole month is traversed, not its first 21,000 games.** Filling both splits from the top
of the file costs 80 seconds against 2.5 minutes, but draws every game from the first hours of
April 1. A header-only scan runs at 11,400 games/s against 300 for a full parse — python-chess
skips a game's movetext when the visitor returns `SKIP` from `end_headers()` — so traversing
1.39M games and fully parsing 20,801 of them is affordable. CW-159 had already shown what a
contiguous slice costs: the evaluation dump's first 200,000 records reported 18.4% mates
against a true 12.4%.

**Starting at ply 8 rather than 12.** A later start holds transpositions down — measured over
the same 20,000 games, 113 keys land in both splits from a 12–16 start against 588 from 8–12 —
but a held-out set beginning at ply 12 contains almost no opening play, and openings are a large
share of what the app is asked to evaluate. 0.80% of a split, resolved by CW-162 against a
40,000-position margin down to the final 50,000, is the price of that coverage.

**The window is four plies wide, not five, and that is what balances the side to move.** Two of
8–11 are even and two odd, so the starting parity is even. With a five-wide window (8–12, three
even and two odd) 60% of games start with White to move, and because a step of 4 or 6 preserves
the side to move while only 5 flips it, that bias decays as (1/3)^k rather than vanishing: the
first build came out **51.1% White in both splits**, and four wide it is 49.7/50.3. The residual
0.3 points now leans the other way and comes from the game-length distribution, not the window.
This is the cheap way to get the balance — the alternative, deleting real positions afterwards,
corrects something a mover-relative input encoding cannot perceive in the first place.

**The cap keeps a uniform subset, not the first ten.** Ten steps at 4–6 plies reach ply ~55,
and 6,596 of val's 10,423 games are long enough to hit the cap, so truncating would have ended
both splits in the middlegame. The subset is why the ply distribution runs out to 217.

**A consequence for verification:** the gaps between plies *written to the file* are sums of 4,
5 and 6, so the spacing rule cannot be read off the output directly. `measure_candidates.py`
regenerates each game's `ply_schedule` and checks membership instead — which also proves the
whole pass is reproducible from the game IDs alone, since a non-deterministic sample would fail
that check.

**Positions with no legal move are rejected**, because CW-163 cannot get a score for a
checkmate. Dead draws are **kept** — 4 in each split, all bare-king or K+N/K+B endgames. They
are legal, correctly scored 0.00, and a held-out set that quietly drops them is teaching to the
test.

**One zstd compressor per output file.** A `ZstdCompressor` owns a single compression context,
so two `stream_writer`s sharing one interleave their frames and corrupt both outputs — the
first loses its frame header entirely. Caught on the first read, but it cost a rerun.

---

## The held-out splits — CW-162

`ml/data/val_positions.jsonl.zst` and `test_positions.jsonl.zst` — exactly 50,000 records each,
1.1 MB each, written by `ml/scripts/select_heldout.py` in seconds. Same record shape as the
candidates, written in `(game_id, ply)` order. These are what CW-163 labels and CW-164 freezes.

| | val | test |
|---|---|---|
| candidates | 90,009 | 90,002 |
| after within-split deduplication | 89,225 (−784) | 89,243 (−759) |
| after cross-split resolution | 88,867 (−358) | 88,890 (−353) |
| selected | **50,000** | **50,000** |
| ply < 20 / 20–60 / > 60 | 22.1% / 58.8% / 19.1% | 22.2% / 58.6% / 19.3% |
| side to move | 49.6% White | 49.4% White |

**Deduplication keeps the record with the smallest `(game_id, ply)`, not the first one seen.**
First-seen depends on the order the candidate file happens to be in, so a rebuild could keep a
different copy of the same position and quietly change the split's contents. Which copy survives
does not matter; that it is always the same one does.

**A key in both splits goes to one of them, and is not deleted from both.** The winner is
`blake2b(key, person=b"tiebreak") % 2`. Colliding keys are transpositions — different games
reaching the same position — so they are the *commonest* positions in chess, and dropping them
everywhere would strip exactly those out of the held-out sets. Nothing leaks either way, because
CW-164's blocklist is the union of both splits, so training excludes the key whichever side keeps
it. The 711 collisions split 358/353, which is the tiebreak being unbiased in practice and not
only in principle.

**The cut to 50,000 is a hash rank, not a random sample.** `blake2b(key, person=b"select")`
sorted, first 50,000: a rank rather than a modulus because the count has to be exact, and a hash
rather than `random.sample` for the reason CW-159 hashed instead of seeding an RNG — the outcome
depends only on which keys exist, so it survives a rerun or a reordering of the input.

**It is also uniform in what the position contains, which is checkable:** selecting 56% of the
candidates moved side to move from 49.7/50.3 to 49.6/50.4, and the two splits' ply spreads agree
to a tenth of a point. A rank that correlated with game progress would have shown up here as a
split short of endgames — the same failure the CW-161 cap was designed around, and why 19% of
each split still sits past ply 60.

**The spread is reported and nothing is rebalanced on it**, as CW-162 requires. The cut never
looks at the ply, so there is no mechanism by which it could be.

---

## Scripts

| | |
|---|---|
| `streams.py` | `iter_lines` / `iter_games` / `open_pgn` — generators and a handle over a decompressing stream, flat memory, stopping early costs nothing |
| `peek.py` | first few records of each dump; the evidence that neither is ever decompressed in full |
| `inspect_eval.py` | the perspective and record-shape tests, over the dump's first 200,000 records |
| `build_sample.py` | the one pass that produced the candidate pool |
| `measure_sample.py` | the pool measurement; writes `eval_sample_report.txt` |
| `canonical.py` | the position key and the target scale (CW-160), imported by everything downstream |
| `build_heldout_candidates.py` | the one pass over the games dump that produced both candidate files |
| `measure_candidates.py` | CW-161's acceptance checks; writes `heldout_candidates_report.txt` |
| `select_heldout.py` | CW-162 — deduplicates, resolves the cross-split collisions, cuts to 50,000 each; writes `heldout_splits_report.txt` |
