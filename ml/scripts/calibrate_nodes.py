"""Turns CW-163's 200 ms into a node count, once.

The run itself is node-limited, because a time limit makes every label depend on
machine load and on how many processes share a core — which the ticket's own
"result does not depend on how many ran at once" forbids. But the *size* of the
budget should still be the 200 ms the ticket specifies, so it is measured here
under a time limit, on an idle machine, in one process, and then frozen.

Frozen, not recomputed: a faster machine would otherwise silently relabel the
dataset on a deeper scale, and the two splits would stop being comparable.
"""

import json
import os
import statistics
import sys
import time

from build_heldout_candidates import SPLITS
from engine import Engine, parse_info
from select_heldout import OUTPUT as POSITIONS
from streams import iter_lines

MOVETIME_MS = int(os.environ.get("STOCKFISH_MOVETIME_MS", "200"))
SAMPLE_PER_SPLIT = 150

# A search that ended before spending its budget tells us nothing about what the
# budget buys. Solved mates stop at Stockfish's ply ceiling after a few thousand
# nodes, so including them would drag the median down and quietly shorten every
# search in the real run.
MIN_TIME_MS = MOVETIME_MS - 20


def sample(split, n):
    """The first n positions of a split — the file is already in game order and
    the choice of which positions to time does not affect the result."""
    out = []
    for raw in iter_lines(POSITIONS[split]):
        out.append(json.loads(raw))
        if len(out) == n:
            return out
    return out


def main():
    with Engine() as engine:
        print(f"engine: {engine.id_name}   movetime {MOVETIME_MS} ms")
        nodes, skipped = [], 0
        for split in SPLITS:
            for record in sample(split, SAMPLE_PER_SPLIT):
                engine._send("ucinewgame")
                engine._send("isready")
                engine._read_until("readyok")
                engine._send(f"position fen {record['fen']}")
                engine._send(f"go movetime {MOVETIME_MS}")
                lines = engine._read_until("bestmove")
                cp, mate, depth, searched = parse_info(lines)
                spent = max((int(l.split(" time ")[1].split()[0])
                             for l in lines if " time " in l), default=0)
                if spent < MIN_TIME_MS or mate is not None:
                    skipped += 1
                    continue
                nodes.append(searched)

    nodes.sort()
    print(f"timed {len(nodes)} positions, skipped {skipped} "
          f"(finished early or solved)")
    for p in (10, 25, 50, 75, 90):
        print(f"  p{p:<3} {nodes[int(p / 100 * (len(nodes) - 1))]:>10,}")
    median = int(statistics.median(nodes))
    print(f"\nmedian {median:,}  ->  suggested NODES = {round(median, -4):,}")
    print("Rounded on purpose: the constant is a decision, not a measurement, and")
    print("a round number cannot be mistaken for a reading that must be matched.")


if __name__ == "__main__":
    main()