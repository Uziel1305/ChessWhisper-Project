"""The set of position keys training must never contain (CW-164).

The union of the validation and test keys, and nothing else. Positions that were
candidates in CW-161 but were not selected in CW-162 belong to no held-out split,
so training may contain them freely.

Keys rather than FENs, because the key is what decides whether the model can tell
two positions apart (CW-160): blocking a FEN would let the same position through
under a different halfmove clock. Sorted on write, so the file and its checksum
depend only on WHICH positions are held out, never on the order they were written.

This module is also the training pipeline's only door to the blocklist — load()
below. No training code path opens the test set itself, which is CW-164's third
requirement, and structuring it this way is what makes that true by construction
rather than by discipline.
"""

import hashlib
import json
from pathlib import Path

from build_heldout_candidates import SPLITS
from canonical import position_key
from select_heldout import OUTPUT as POSITIONS
from streams import iter_lines

DATA = Path(__file__).resolve().parents[1] / "data"
BLOCKLIST = DATA / "blocklist.txt"

# Plain text, one key per line: ~4 MB, it greps and it diffs. Kept out of Git with
# the rest of ml/data and reproducible from the two position files plus this
# script — the SHA-256 printed below is what makes that checkable.


def keys_of(split):
    return {position_key(json.loads(raw)["fen"])
            for raw in iter_lines(POSITIONS[split])}


def load():
    """The blocklist as a set, for the training pipeline to reject against."""
    if not BLOCKLIST.exists():
        raise FileNotFoundError(
            f"{BLOCKLIST} is missing — run scripts/blocklist.py first. "
            f"Training must not be built without it.")
    with open(BLOCKLIST, encoding="utf-8") as fh:
        return {line.strip() for line in fh if line.strip()}


def main():
    per_split = {s: keys_of(s) for s in SPLITS}
    for split in SPLITS:
        print(f"{split:<5} {len(per_split[split]):,} keys")

    # CW-162 gave every shared key to exactly one split, so this must be empty.
    # If it is not, the two held-out sets overlap and the blocklist would hide it.
    overlap = per_split[SPLITS[0]] & per_split[SPLITS[1]]
    print(f"in both splits: {len(overlap):,}  (CW-162 resolved these; expected 0)")

    union = sorted(set().union(*per_split.values()))
    BLOCKLIST.write_text("\n".join(union) + "\n", encoding="utf-8")
    digest = hashlib.sha256(BLOCKLIST.read_bytes()).hexdigest()

    print(f"\nblocklist {len(union):,} keys  "
          f"{BLOCKLIST.stat().st_size / 1e6:.1f} MB")
    print(f"sha256    {digest}")
    print(f"written   {BLOCKLIST}")


if __name__ == "__main__":
    main()