# Dataset notes — epic CW-158

How the dataset was built, split, labeled and verified. Each section carries the measurements
its decisions were made on; the `*_report.txt` files beside this one hold the raw output.

**One thing to know before reading the early sections.** The training labels were originally to
come from the Lichess evaluation database, and CW-159 to CW-160 are written from inside that
plan. They were switched to positions sampled from games and labeled by our own Stockfish, once
the held-out splits existed and the two distributions could be compared — see *The training set*
below for the measurements that decided it. The evaluation dump is no longer a label source, but
it is still where the frozen target scale came from, so those sections stay as written.

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
MAX_CP    = 10000     # ceiling for |cp|; the mate band begins above it
Y         = 68        # max |mate| across the whole dump
MATE_STEP = 10
```

```python
mate_value(N) = sign(N) * (MAX_CP + MATE_STEP * (Y - abs(N) + 1))
```

Mate in 1 → 10,680. Mate in 68 → 10,010, ten clear of the ceiling. Strictly ordered by distance
to mate, every value strictly outside the centipawn range.

`Y` and `MATE_STEP` come from the 1,023,606-row dump sample and have never moved. No record has
`|mate| == 0` or `|mate| >= 100`, so neither edge case arises, and the conversion asserts
`|N| <= Y` so a record from outside that range fails loudly rather than encoding to a value
inside the centipawn range or with an inverted sign.

### MAX_CP was re-frozen once, 20,000 → 10,000

In October 2026, after all 600,000 positions had been labeled by our own Stockfish and the
evaluation dump had stopped being a label source. 20,000 was *Lichess's* clamp — it described a
source the dataset no longer uses.

What replaced it, measured across the complete dataset:

| | |
|---|---|
| max `\|raw_cp\|` | **9,165** — train 9,165, val 9,165, test 2,863 |
| rows above 4,000 `\|cp\|` | **3 of 600,000**, all three exactly 9,165 (2 train, 1 val) |
| max `\|raw_mate\|` | 19 — against a frozen `Y` of 68 |

The three extremes being *identical*, in two independently sampled splits, with a 5,000-point
empty gap beneath them, is the signature of a **structural ceiling in Stockfish 19's normalized
cp output** rather than a sample maximum. That is what makes fitting the scale to it defensible
instead of overfitting to three rows. 10,000 is that ceiling rounded up: above it so nothing is
ever clamped, round enough to read as a decision rather than a reading, and close enough to halve
the distance from the median row to the mate band — 43× instead of 86×.

**Cost of the change:** 28,137 mate rows recomputed (2,347 val, 2,258 test, 23,532 train), all
three files rewritten with new checksums. **Nothing was re-searched** — `target_value` is derived
from `raw_cp` and `raw_mate`, which is exactly why those columns exist. The merge asserts that the
rows which moved are precisely the mate rows: a centipawn row among them would mean the new
ceiling was eating real data rather than guarding against it.

**It does not move again for this dataset version.** A constant re-frozen twice is not frozen.

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

**No rebalancing was applied** — and in the end nothing was drawn from this pool at all. The
500,000 training set comes from games (see *The training set* below); these figures remain as the
measurement the frozen scale was taken from, and as the evidence that decided the switch.

- **Side to move.** 51.0/49.0 is one percentage point. Deleting 21,424 real rows to close it
  would trade data for an effect too small to measure — and the games-sourced splits that
  replaced this pool came out at 49.8/50.2 and 49.6/50.4 anyway, balanced at source by the width
  of the opening window rather than by deletion.
- **Mate frequency.** 12.4%, not the 18.4% the dump's first 200,000 records suggested. That
  contiguous slice was unrepresentative in other ways too — it showed 53% single-eval records
  against a true 91.6% — which is the whole argument for measuring on a uniform sample.
- **Magnitude.** A third of the pool sits at three pawns or more. A 10% error on a 20,000
  target is 2,000 centipawns against 8 on the median 80 — squared, 62,500 times the
  contribution. Thinning mates would not touch that; the target transform in the training
  script is what addresses it, and it costs no rows.

Any correction, had one been warranted, would have been **undersampling only** — real positions
removed, nothing synthesised, duplicated or mirrored. Mirroring specifically does not rebalance
the *sign* distribution: it maps a position to one carrying the **same** side-to-move target,
because the mover's advantage travels with the mover, so it changes whose turn it is and nothing
else.

That is an argument about what mirroring fixes, not about whether it is useful. Under v1's
**absolute** input encoding (CW-229), mirroring the board, swapping piece colours and flipping
the side-to-move input produces a genuinely different tensor with an unchanged target — real
augmentation that doubles the training data for free. It stays out of the dataset regardless: a
mirrored row here would be a synthetic position presented as a sampled one, and augmentation
belongs to the training script, like every other training-time transformation.

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
This is the cheap way to get the balance, and worth having rather than shrugging at: v1 encodes
positions absolutely and carries the side to move as its own input (CW-229), so it is a feature
the network actually sees. The alternative — deleting real rows afterwards — costs data to fix
something the sampling window fixes for nothing.

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

## Labeling — CW-163 (held-out) and CW-276 (training)

All three splits are labeled by one binary at one budget. That identity is the dataset's central
guarantee: a gap between training loss and validation error can then only be the model's doing.

| | |
|---|---|
| engine | Stockfish 19, `sha256 45bc8e4969147db9c2eb533810637994619bff0eacc81ccfd9854394901bcbd0` |
| network | `nn-1a298aa575a0.nnue`, embedded — pinned by pinning the binary |
| options | `Threads 1`, `Hash 16`, `MultiPV 1`, all set explicitly |
| budget | `go nodes 110000` |
| held-out run | 100,000 positions, 4 workers, 15.4 positions/s, ~1.8 h |

**The budget is a node count, not the 200 ms CW-163 specified.** 200 ms was measured once, in one
process on an idle machine: the median held-out position searched 111,536 nodes (p10 61,477, p90
154,859 over 286 positions), frozen at 110,000. A time limit cannot satisfy CW-163's own bullets.
This CPU has 4 physical cores behind 8 logical threads, so eight `Threads 1` engines each search
roughly half of what one alone manages in 200 ms, and a laptop throttles over an hour at load —
so "the result does not depend on how many ran at once" would be false, and "re-evaluating
reproduces the values already recorded" would need a tolerance. Under a node limit both are
exact. Frozen for the same reason the scale is: a faster machine recalibrating would relabel the
dataset on a deeper scale with nothing in the rows to show it.

**`ucinewgame` before every position.** Otherwise the transposition table carries over, a
position's score depends on which positions preceded it, and the work split silently changes the
labels.

**The node limit is an upper bound, not a target.** A solved position stops at Stockfish's ply
ceiling after a few thousand nodes — so `depth 245` in a row means *solved*, not *searched
deeply*, and the reported `depth` percentiles below exclude mate rows for that reason.

**Reproduction, CW-163's last bullet, is exact.** 200 positions chosen by hash, re-evaluated by
**one** engine, reproduced `raw_cp`, `raw_mate`, `depth` and `nodes` for all 200 — although the
labels came from **four** engines walking the positions in a different order. That is the
strongest available evidence that the `ucinewgame` isolation works and the worker count cannot
affect a label. `heldout_reproduction_report.txt`.

### The labeled splits

`train_labeled.jsonl.zst` (500,000 rows, 15.2 MB), `val_labeled.jsonl.zst` and
`test_labeled.jsonl.zst` (50,000 each, 1.6 MB each). Nine fields per row: `fen`, `split`,
`source_game_id`, `ply`, `target_value`, `raw_cp`, `raw_mate`, `depth`, `nodes`. Written in
`(game_id, ply)` order — the logs are produced in worker-completion order, which would differ on
a rerun, and a checksum over an unreproducible order says nothing.

| | train | val | test |
|---|---|---|---|
| rows | 500,000 | 50,000 | 50,000 |
| sha256 | `6c1b3f4bf7ba326a2a21d12372f0200f6940835fcdbcdd05aedbe59cba86a773` | `d1c9ca0e85f8a23f8ef6c392e742725a81373fb8773a60841f41b30de6617e1c` | `f154193e73eb4291830fcc895fb40916e223c7006849677f9b24b07ad36cba6a` |
| score kind | cp 95.3% / mate 4.7% | cp 95.3% / mate 4.7% | cp 95.5% / mate 4.5% |
| `\|cp\|` | p50 251, p90 847, p99 1,325, max 9,165 | p50 240, p90 842, p99 1,317, max 9,165 | p50 238, p90 848, p99 1,316, max 2,863 |
| max `\|mate\|` | 19 | 18 | 17 |
| depth on cp rows | p10 14, p50 16, p90 18 | same | same |
| rows the cp clamp touched | 0 | 0 | 0 |
| mate rows moved by the re-freeze | 23,532 | 2,347 | 2,258 |

**Those three columns are the dataset's central claim, measured.** Sourcing all three splits the
same way and labeling them with one binary at one budget was supposed to put them on one
distribution; mate fractions of 4.7 / 4.7 / 4.5%, medians of 251 / 240 / 238, p99s of 1,325 /
1,317 / 1,316 and an identical median depth of 16 are what that looks like from outside. Nothing
here was tuned to make those agree.

No perspective flip is applied anywhere: `target_value == raw_cp` on every cp row, because UCI
reports from the side to move and so does the `Evaluator` contract. `target_from_side_to_move` is
the only conversion entry point the pipeline uses.

---

## The blocklist — CW-164

`ml/data/blocklist.txt` — 100,000 keys, one per line, sorted.
`sha256 e628984eb67e9c5d3abff1cabba3d879c6e55b9f799151ecea64f9998ba49a12`.

The union of the validation and test keys, and nothing else: a candidate that was sampled in
CW-161 but not selected in CW-162 belongs to no held-out split, so training may contain it. The
union being exactly 100,000 is also the proof that the two splits do not overlap.

Keys rather than FENs, because the key is what decides whether the model can tell two positions
apart — blocking a FEN would let the same position through under a different halfmove clock.
Sorted on write, so the file and its checksum depend only on which positions are held out.

`blocklist.load()` is the training pipeline's only door to it, and no training code path opens
the test set itself. That is CW-164's third requirement made structural rather than a matter of
discipline.

**The test set is reserved for final evaluation.** It is not used for architecture selection,
feature selection, learning-rate tuning, epoch selection, regularisation, preprocessing
decisions, or choosing between model versions. Validation carries all of those.

---

## The training set — from games, not the dump

Training was switched from the Lichess evaluation database to positions sampled from games and
labeled by the same Stockfish, once the held-out splits existed and the two distributions could
be compared side by side. The comparison is what decided it:

| | evaluation dump | our labels |
|---|---|---|
| mate fraction | 12.4% | 4.6% |
| median `\|cp\|` | 80 | 239 |
| p99 `\|cp\|` | 3,587 | 1,317 |
| search depth | 46–95 | 16 |

Three mismatches in three different directions, on a distribution the model would be scored
against but never trained on. Against that, the dump's one real advantage is depth — and depth is
not the binding constraint at this model's capacity, since a 500,000-row MLP will not approach
depth-16 Stockfish, let alone depth-50.

**It also closes a leak that could not otherwise be measured.** Training games are now disjoint
from the held-out games, so a training position can never be a *near*-duplicate — one ply away,
same game — of a held-out position. The dump made that impossible to check at all, because it
carries no game IDs. Game-level disjointness does not stop transpositions, which is what the
blocklist is for; both mechanisms are needed and both now exist.

### Candidates

`train_candidates.jsonl.zst` — 600,004 records, 12.4 MB, built in 4.7 minutes by
`build_train_candidates.py`.

| | |
|---|---|
| games traversed | 1,160,997 of 1,785,417 (65% of the month) |
| game accepted when | `not is_accepted(id)` **and** `blake2b(id, person=b"train") % 16 == 0` |
| yield | 8.67 per game from 69,189 games |
| games shared with the held-out candidates | **0** |

**Disjointness is structural, not a lookup.** `is_accepted()` decides whether a game may feed
validation or test *at all*, so training takes only games where it is false — no list to load and
nothing to keep in sync. Keying on the rule rather than on the 20,801 games actually used matters:
the held-out pass stopped at 78% of the month with both splits full, so ~7,000 eligible games went
unused, and a later re-run of CW-161 with a bigger target must not start pulling games that are
already in training. The 0 above is the check anyway, because a rule that prevents overlap is not
evidence that none occurred.

**The sampling rule is CW-161's, reused rather than restated** — same ply schedule, same 4–6
spacing, same cap, the same `CandidateSampler` with its game rules passed in. The yield of 8.67
against the held-out splits' 8.64 and 8.67 is what that identity looks like from outside.

### Selection

`train_positions.jsonl.zst` — exactly 500,000 positions, 10.6 MB.
`sha256 2e4956478951b3935d9ce49f4031b7bd88a2df93ae3ffa9070d5389982324b71`.

| | |
|---|---|
| candidates | 600,004 |
| after deduplication | 587,055 (−12,949 duplicate keys) |
| after the blocklist | 584,884 (−2,171 held-out keys) |
| selected | 500,000 from 68,919 games |
| ply spread | < 20 21.0%, 20–60 59.4%, > 60 19.7% |
| side to move | 49.8% White |
| ply percentiles | p25 22, p50 36, p75 55, p90 75, max 255 |

**The 2,171 blocklist hits are the ones that matter.** Each is a position reached by a training
game *and* by a held-out game, and every one would have put a validation or test position into
training. Game disjointness would not have caught a single one.

The ply spread and side-to-move balance match the held-out splits to within a percentage point
(22.1 / 58.8 / 19.1 and 22.2 / 58.6 / 19.3; 49.6% and 49.4% White). That is the one-distribution
claim as a measurement rather than an intention.

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
| `engine.py` | the pinned Stockfish and its UCI client; holds the SHA-256, the options and `NODE_LIMIT`, and asserts the binary at every start |
| `calibrate_nodes.py` | the one-off measurement that turned CW-163's 200 ms into a node count |
| `label_heldout.py` | labels every split — val, test and train — resumable, one engine per worker |
| `merge_labels.py` | orders, compresses and verifies the labeled splits; writes `heldout_labels_report.txt` |
| `verify_labels.py` | re-evaluates 200 positions and demands identical values; writes `heldout_reproduction_report.txt` |
| `blocklist.py` | CW-164 — builds the 100,000-key blocklist and is the training pipeline's only door to it |
| `build_train_candidates.py` | samples 600,000 training candidates from games barred from val/test |
| `select_train.py` | deduplicates, rejects blocklisted keys, cuts to 500,000; writes `train_split_report.txt` |
