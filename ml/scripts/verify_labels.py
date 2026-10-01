"""Re-evaluates a sample of labeled positions and demands identical numbers.

CW-163's last acceptance bullet. Under a node limit with Threads 1, a fixed hash
size and ucinewgame before every position, a Stockfish search is deterministic —
so "reproduces" here means bit-identical, not "within a tolerance".

Every field is compared, depth and nodes included. If the search followed the same
path it must have reached the same depth after the same node count; if it did not,
one of those four assumptions is false and the comparability of the whole dataset
is in question. This is also the only real test of the ucinewgame claim: the
labeling pass used four engines each handling ~25,000 positions in a different
order, while this uses one engine over 200, so matching values mean the
transposition table really is being cleared between positions.

The sample is chosen by hash of the FEN rather than by file order, so it is the
same 200 positions on every run and on every machine, and it is not biased toward
whichever rows happen to sit at the top of the file.
"""

import hashlib
import json
from pathlib import Path

from build_heldout_candidates import SPLITS
from canonical import target_from_side_to_move
from engine import NODE_LIMIT, VERSION, Engine
from merge_labels import OUTPUT as LABELED
from streams import iter_lines

REPORT = Path(__file__).resolve().parents[1] / "notes" / "heldout_reproduction_report.txt"
SAMPLE_PER_SPLIT = 100

COMPARED = ("raw_cp", "raw_mate", "depth", "nodes", "target_value")

lines = []


def say(text=""):
    print(text)
    lines.append(text)


def rank(fen):
    digest = hashlib.blake2b(fen.encode(), digest_size=8, person=b"verify").digest()
    return int.from_bytes(digest, "big")


def sample(split, n):
    rows = [json.loads(raw) for raw in iter_lines(LABELED[split])]
    rows.sort(key=lambda r: rank(r["fen"]))
    return rows[:n]


def main():
    say("CW-163 — REPRODUCTION CHECK")
    say(f"{VERSION}   go nodes {NODE_LIMIT:,}   Threads 1   Hash 16 MB   MultiPV 1")
    say(f"{SAMPLE_PER_SPLIT} positions per split, chosen by hash of the FEN")
    say()

    total = mismatched = 0
    with Engine() as engine:
        for split in SPLITS:
            bad = 0
            for row in sample(split, SAMPLE_PER_SPLIT):
                cp, mate, depth, nodes = engine.evaluate(row["fen"], NODE_LIMIT)
                fresh = {
                    "raw_cp": cp,
                    "raw_mate": mate,
                    "depth": depth,
                    "nodes": nodes,
                    "target_value": target_from_side_to_move(cp=cp, mate=mate),
                }
                differing = {f: (row[f], fresh[f]) for f in COMPARED
                             if row[f] != fresh[f]}
                total += 1
                if differing:
                    bad += 1
                    say(f"  MISMATCH  {row['fen']}")
                    for field, (stored, now) in differing.items():
                        say(f"    {field}: recorded {stored}, now {now}")
            mismatched += bad
            say(f"{split}: {SAMPLE_PER_SPLIT - bad}/{SAMPLE_PER_SPLIT} "
                f"reproduced exactly")

    say()
    say(f"[{'PASS' if not mismatched else 'FAIL'}] "
        f"{total - mismatched}/{total} positions reproduced every compared field "
        f"exactly")
    if mismatched:
        say("A mismatch means the search was not deterministic. Check Threads, Hash,")
        say("MultiPV, the ucinewgame before each position, and the binary's SHA-256 —")
        say("and do not treat the labels as one scale until it is explained.")

    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text("\n".join(lines), encoding="utf-8")
    print(f"\nwritten to {REPORT}")


if __name__ == "__main__":
    main()