"""Samples training candidate positions from games the held-out splits never used.

Same month, same ply schedule, same per-game cap as CW-161 — reusing that
visitor rather than restating the rule, because which positions a game yields is
the one thing that must be identical across all three splits. That identity is
what sourcing training from games buys: one distribution, one engine, one budget,
so validation error is comparable to training loss.

Game disjointness is structural, not a lookup. is_accepted() decides whether a
game may feed validation or test at all, so this pass takes only games where it is
false — no list to load, nothing to keep in sync, and the two classes cannot
overlap. The pass still reports the intersection of its game IDs with the held-out
ones at the end, because a rule that prevents overlap is not the same thing as
evidence that none occurred.
"""

import contextlib
import json
import sys
import time

import chess.pgn
import zstandard

from build_heldout_candidates import (
    DATA,
    MONTH_GAMES,
    OUTPUT as HELDOUT_CANDIDATES,
    PROGRESS_EVERY,
    SKIPPED,
    SOURCE,
    SPLITS,
    CandidateSampler,
    _digest,
    is_accepted,
)
from streams import iter_lines, open_pgn

OUTPUT = DATA / "train_candidates.jsonl.zst"
SPLIT = "train"

# 500,000 are wanted. Sampling 600,000 leaves room for the two filters that run
# before selection: within-training duplicates, which scale with the square of the
# sample (784 in 90,009 held-out candidates implies ~35,000 here), and the
# 100,000-key blocklist (~5,400 by the same extrapolation). That should leave
# ~560,000 to select 500,000 from. If it undershoots, raising this and re-running
# costs six minutes.
TARGET = 600_000

# 1 in 16 of the ~1,757,500 games barred from val/test is ~110,000 games, and at
# 8.6 candidates each the pass fills at roughly two-thirds of the way through the
# month. 1 in 24 would have been enough on paper and left almost no margin if the
# yield came in low. A power of two for the same reason GAME_KEEP_ONE_IN is one:
# halving it keeps every game already accepted.
TRAIN_KEEP_ONE_IN = 16


def is_train_game(game_id):
    """Whether this game may contribute training positions.

    Two conditions. The first is disjointness: a game that is_accepted() MAY feed
    validation or test, so training never touches it — whether or not CW-161
    actually reached it. That distinction matters. The held-out pass stopped at 78%
    of the month with both splits full, so roughly 7,000 eligible games went
    unused; keying on the rule rather than on the 20,801 games actually used means
    a later re-run of CW-161 with a bigger target cannot start pulling games that
    are already in training.

    The second spreads the draw across the whole month rather than taking it from
    the first days, the same argument as GAME_KEEP_ONE_IN.
    """
    if is_accepted(game_id):
        return False
    # _digest is imported rather than reimplemented so the construction — 8-byte
    # blake2b, big-endian — is identical to every other hash in the pipeline.
    return _digest(game_id, b"train") % TRAIN_KEEP_ONE_IN == 0


def heldout_game_ids():
    """Every game the held-out pass sampled, selected or not — the stricter set."""
    ids = set()
    for split in SPLITS:
        for raw in iter_lines(HELDOUT_CANDIDATES[split]):
            ids.add(json.loads(raw)["game_id"])
    return ids


def main():
    count = games_used = seen = 0
    stats = {"parse_errors": 0}
    finished_month = False
    game_ids = set()
    started = time.time()

    def wanted(_split):
        return count < TARGET

    with contextlib.ExitStack() as stack:
        raw = stack.enter_context(open(OUTPUT, "wb"))
        out = stack.enter_context(
            zstandard.ZstdCompressor(level=10).stream_writer(raw))
        text = stack.enter_context(open_pgn(SOURCE))

        while count < TARGET:
            outcome = chess.pgn.read_game(
                text, Visitor=lambda: CandidateSampler(
                    is_train_game, lambda _gid: SPLIT, wanted, stats))
            if outcome is None:
                finished_month = True
                break
            seen += 1
            if outcome is not SKIPPED:
                _split, records = outcome
                for record in records:
                    out.write((json.dumps(record) + "\n").encode())
                count += len(records)
                if records:
                    games_used += 1
                    game_ids.add(records[0]["game_id"])

            if seen % PROGRESS_EVERY == 0:
                rate = seen / (time.time() - started)
                print(f"{seen:,} games  {count:,}/{TARGET:,} candidates  "
                      f"{rate:,.0f} games/s", file=sys.stderr, flush=True)

    elapsed = time.time() - started
    overlap = game_ids & heldout_game_ids()

    print(f"\ngames read      {seen:,} of {MONTH_GAMES:,} "
          f"({100 * seen / MONTH_GAMES:.0f}% of the month)"
          f"{'  — reached the end' if finished_month else ''}")
    print(f"candidates      {count:,} from {games_used:,} games "
          f"({count / max(games_used, 1):.2f} per game)")
    print(f"output          {OUTPUT.name}  "
          f"{OUTPUT.stat().st_size / 1e6:.1f} MB")
    print(f"parse errors    {stats['parse_errors']:,}")
    print(f"games shared with the held-out candidates: {len(overlap):,}  "
          f"(expected 0)")
    print(f"elapsed         {elapsed / 60:.1f} min")


if __name__ == "__main__":
    main()