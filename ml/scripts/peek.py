"""Prints the first few records of each dump, then stops.

This is the evidence for CW-159's second acceptance bullet: record by record
from the compressed file, never decompressed in full, never held in memory.
The proof is that it returns in well under a second against a 300 MB file and
a tens-of-GB one alike — it reads only as far as it is asked to.
"""

from pathlib import Path

from streams import iter_lines, iter_games

DATA = Path(__file__).resolve().parents[1] / "data"
EVAL = DATA / "lichess_db_eval.jsonl.zst"
PGN = DATA / "lichess_db_standard_rated_2015-04.pgn.zst"
N = 3


def peek_pgn():
    print(f"=== {PGN.name}: first {N} games ===")
    for i, game in enumerate(iter_games(PGN)):
        if i >= N:
            break
        h = game.headers
        plies = sum(1 for _ in game.mainline_moves())
        print(f"[{i}] {h.get('Site')}  {h.get('White')} ({h.get('WhiteElo')}) "
              f"vs {h.get('Black')} ({h.get('BlackElo')})  "
              f"{h.get('Result')}  {plies} plies")


def peek_eval():
    print(f"\n=== {EVAL.name}: first {N} lines ===")
    for i, line in enumerate(iter_lines(EVAL)):
        if i >= N:
            break
        print(f"[{i}] {len(line)} bytes")
        print(line[:500].decode("utf-8", "replace") + " ...\n")


if __name__ == "__main__":
    peek_pgn()
    if EVAL.exists():
        peek_eval()
    else:
        print(f"\n{EVAL.name} not present yet — skipped")