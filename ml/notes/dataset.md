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

Validation and test need ~10,000 games between them (≈5,000 each, at ~10 positions per game).
Every month from 2014 onward carries hundreds of thousands, so file size past that point is
cost with no benefit — a 2017 month is 6.55 GB for the same ~10,000 games. 2015-04 is the
earliest month comfortably above a million games, which gives a hundredfold surplus and a
normal rating spread while streaming end to end in minutes.

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

## Scripts

| | |
|---|---|
| `streams.py` | `iter_lines` / `iter_games` — generators over a decompressing stream, flat memory, stopping early costs nothing |
| `peek.py` | first few records of each dump; the evidence that neither is ever decompressed in full |
| `inspect_eval.py` | the perspective and record-shape tests, over the dump's first 200,000 records |
| `build_sample.py` | the one pass that produced the candidate pool |
| `measure_sample.py` | the pool measurement; writes `eval_sample_report.txt` |
