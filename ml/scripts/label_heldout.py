"""Labels all 100,000 held-out positions with the pinned Stockfish (CW-163).

Two properties make this pass restartable and its output independent of how it
was scheduled. It is node-limited, so a label does not depend on machine load or
on how many workers ran. And ucinewgame runs before every position, so a label
does not depend on which positions preceded it — without that, the transposition
table would carry over and the work split would silently change the values.

Append-only for the same reason: every row is written as it arrives and a restart
skips the FENs already present. A 1.5-hour job that cannot resume is a 1.5-hour
job you run twice.
"""

import atexit
import json
import os
import sys
import time
from multiprocessing import Pool
from pathlib import Path

from build_heldout_candidates import SPLITS
from canonical import target_from_side_to_move
from engine import NODE_LIMIT, SHA256, VERSION, Engine
from select_heldout import OUTPUT as POSITIONS
from streams import iter_lines

LABELS = Path(__file__).resolve().parents[1] / "data" / "labels"
LOG = {s: LABELS / f"{s}_labels.jsonl" for s in SPLITS}

# One process per physical core by default. This CPU has 4 physical behind 8
# logical, and two engines sharing a core is worse than useless under a node
# limit — the work just takes longer. Raise it to 8 to measure whether
# hyperthreading buys aggregate throughput here.
WORKERS = int(os.environ.get("STOCKFISH_WORKERS", "4"))
CHUNK = 4
FLUSH_EVERY = 50

# Plain .jsonl, not .zst: this is an append log that a crash must leave readable,
# and a truncated zstd frame is not readable. The final compressed files are the
# merge step's job.

_engine = None


def _init():
    """One Stockfish per worker process, built here rather than at import time
    because Windows multiprocessing re-imports this module in every child."""
    global _engine
    _engine = Engine()
    atexit.register(_engine.close)


def _label(task):
    split, record = task
    return (split, record) + _engine.evaluate(record["fen"], NODE_LIMIT)


def repair(path):
    """Drop a trailing partial line left by a crash mid-write.

    Without this, the next append glues itself onto half a record and produces
    one line that is neither the old row nor the new one."""
    if not path.exists() or path.stat().st_size == 0:
        return
    with open(path, "rb+") as fh:
        fh.seek(-1, os.SEEK_END)
        if fh.read(1) == b"\n":
            return
        size = fh.seek(0, os.SEEK_END)
        while size > 0:
            size -= 1
            fh.seek(size)
            if fh.read(1) == b"\n":
                size += 1
                break
        fh.truncate(size)


def already_labeled(split):
    if not LOG[split].exists():
        return set()
    with open(LOG[split], encoding="utf-8") as fh:
        return {json.loads(line)["fen"] for line in fh if line.strip()}


def main():
    LABELS.mkdir(parents=True, exist_ok=True)
    work = []
    for split in SPLITS:
        repair(LOG[split])
        done = already_labeled(split)
        positions = [json.loads(raw) for raw in iter_lines(POSITIONS[split])]
        todo = [r for r in positions if r["fen"] not in done]
        work.extend((split, r) for r in todo)
        print(f"{split}: {len(positions):,} positions, {len(done):,} labeled, "
              f"{len(todo):,} to do")

    if not work:
        print("nothing to do")
        return

    print(f"{VERSION}  sha256 {SHA256[:12]}...  nodes {NODE_LIMIT:,}  "
          f"workers {WORKERS}")
    started, written = time.time(), 0
    handles = {s: open(LOG[s], "a", encoding="utf-8") for s in SPLITS}
    try:
        with Pool(WORKERS, initializer=_init) as pool:
            for split, record, cp, mate, depth, nodes in pool.imap_unordered(
                    _label, work, CHUNK):
                # target_from_side_to_move, never target_from_white: UCI reports
                # from the side to move and so does the Evaluator contract, so
                # CW-163's "no perspective flip" is satisfied by picking this
                # entry point rather than by remembering not to flip.
                row = {
                    "fen": record["fen"],
                    "split": split,
                    "source_game_id": record["game_id"],
                    "ply": record["ply"],
                    "target_value": target_from_side_to_move(cp=cp, mate=mate),
                    "raw_cp": cp,
                    "raw_mate": mate,
                    "depth": depth,
                    "nodes": nodes,
                }
                handles[split].write(json.dumps(row) + "\n")
                written += 1
                if written % FLUSH_EVERY == 0:
                    for fh in handles.values():
                        fh.flush()
                    rate = written / (time.time() - started)
                    print(f"{written:,}/{len(work):,}  {rate:.1f}/s  "
                          f"~{(len(work) - written) / rate / 60:.0f} min left",
                          file=sys.stderr, flush=True)
    finally:
        for fh in handles.values():
            fh.flush()
            fh.close()

    print(f"\nlabeled {written:,} in {(time.time() - started) / 60:.1f} min")


if __name__ == "__main__":
    main()