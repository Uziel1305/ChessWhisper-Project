"""Writes the three files a training script actually loads: FEN and target, nothing else.

The nine-field `*_labeled.jsonl.zst` files are the archival record — provenance, the
raw scores, the search depth, the game each position came from. These are the
model's input: two columns, uncompressed, loadable with one pandas call and
greppable with none.

CSV rather than JSONL because two columns are a table, and because
`pd.read_csv(path)` needs no decompressor and no per-row JSON parse over 500,000
rows. A FEN contains spaces, slashes and digits but never a comma, so no field is
ever quoted — and csv.writer would quote it correctly if one ever were.

Derived, never authoritative. Anything wrong in these files is fixed by rerunning
this script; nothing downstream of the labeled files depends on them. They are
deliberately not checksummed into the dataset metadata for that reason — the
labeled files are what CW-164 freezes.
"""

import csv
import hashlib
import json
from pathlib import Path

from canonical import MAX_CP, Y, mate_value
from label_heldout import TASKS
from merge_labels import OUTPUT as LABELED
from streams import iter_lines

ROOT = Path(__file__).resolve().parents[1]
FINAL = {s: ROOT / "data" / f"final_{s}.csv" for s in TASKS}

HEADER = ("fen", "target_value")


def main():
    print(f"target scale: cp within +-{MAX_CP:,}, "
          f"mates {mate_value(Y):,} to {mate_value(1):,} (and negated)\n")
    total = 0
    for split in TASKS:
        rows = 0
        lo = hi = None
        mates = 0
        # Row order is inherited from the labeled file, which is (game_id, ply) —
        # so these are reproducible byte for byte, same as their source.
        with open(FINAL[split], "w", encoding="utf-8", newline="") as fh:
            writer = csv.writer(fh)
            writer.writerow(HEADER)
            for raw in iter_lines(LABELED[split]):
                record = json.loads(raw)
                target = record["target_value"]
                writer.writerow((record["fen"], target))
                lo = target if lo is None else min(lo, target)
                hi = target if hi is None else max(hi, target)
                mates += abs(target) > MAX_CP
                rows += 1

        digest = hashlib.sha256(FINAL[split].read_bytes()).hexdigest()
        total += rows
        print(f"{FINAL[split].name}")
        print(f"  rows    {rows:,}")
        print(f"  target  {lo:,} .. {hi:,}")
        print(f"  mates   {mates:,} ({100 * mates / rows:.1f}%) — the rows above "
              f"+-{MAX_CP:,}")
        print(f"  size    {FINAL[split].stat().st_size / 1e6:.1f} MB")
        print(f"  sha256  {digest}")
        print()

    print(f"{total:,} rows across {len(TASKS)} files")


if __name__ == "__main__":
    main()