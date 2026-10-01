"""Cuts the training candidates to exactly 500,000 clean positions.

Three filters in order: duplicate keys within training, keys present in the
held-out blocklist, then a uniform hash-ranked cut to 500,000. The first and
third reuse select_heldout's functions unchanged — the same deduplication and the
same selection rule that produced the held-out splits.

The blocklist rejection is the one that matters for correctness. Training and the
held-out splits come from disjoint games, which stops near-duplicates — consecutive
positions from a single game — but two different games can still reach the
identical position, and game disjointness says nothing about that. Between the two
held-out splits it happened 711 times across 180,000 positions, so at this scale
it is expected to happen thousands of times, and every one of them would be a
held-out position sitting in the training set.
"""

import hashlib
import json
from collections import Counter
from pathlib import Path

import zstandard

from blocklist import load as load_blocklist
from build_train_candidates import OUTPUT as CANDIDATES, heldout_game_ids
from canonical import position_key
from select_heldout import PLY_BUCKETS, bucket_of, dedupe_within, select
from streams import iter_lines

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "data" / "train_positions.jsonl.zst"
REPORT = ROOT / "notes" / "train_split_report.txt"

TARGET = 500_000

lines, checks = [], []


def say(text=""):
    print(text)
    lines.append(text)


def check(ok, label, detail=""):
    checks.append(bool(ok))
    say(f"  [{'PASS' if ok else 'FAIL'}] {label}" + (f"  — {detail}" if detail else ""))


# The fourth copy of this in ml/scripts, after measure_sample, measure_candidates
# and merge_labels. Worth collapsing into one small report module along with say()
# and check(), which those three also reimplement — but that touches five working
# scripts, so not while this one is the thing standing between us and the labels.
def pct(sorted_values, p):
    return sorted_values[min(len(sorted_values) - 1,
                             int(p / 100 * (len(sorted_values) - 1)))]


def main():
    candidates = [json.loads(raw) for raw in iter_lines(CANDIDATES)]
    say("TRAINING SELECTION")
    say()
    say(f"  candidates          {len(candidates):,}")

    keyed = dedupe_within(candidates)
    say(f"  after deduplication {len(keyed):,}  "
        f"(-{len(candidates) - len(keyed):,} duplicate keys)")

    blocked = load_blocklist()
    hits = [key for key in keyed if key in blocked]
    for key in hits:
        del keyed[key]
    say(f"  after the blocklist {len(keyed):,}  "
        f"(-{len(hits):,} held-out keys)")

    chosen = select(keyed, TARGET)
    say(f"  selected            {len(chosen):,}")
    say()

    rows = sorted(chosen, key=lambda r: (r["game_id"], r["ply"]))
    with open(OUTPUT, "wb") as fh, \
            zstandard.ZstdCompressor(level=10).stream_writer(fh) as out:
        for row in rows:
            out.write((json.dumps(row) + "\n").encode())
    digest = hashlib.sha256(OUTPUT.read_bytes()).hexdigest()

    keys = [position_key(r["fen"]) for r in rows]
    games = {r["game_id"] for r in rows}
    say("ACCEPTANCE")
    check(len(rows) == TARGET, f"exactly {TARGET:,} positions", f"{len(rows):,}")
    check(len(set(keys)) == len(keys), "no key appears twice",
          f"{len(keys) - len(set(keys)):,} repeated")
    check(not (set(keys) & blocked), "no key is in the held-out blocklist",
          f"{len(set(keys) & blocked):,} present")
    check(all(r.get("game_id") and r.get("ply") is not None for r in rows),
          "every row carries its source game ID and ply")
    shared = games & heldout_game_ids()
    check(not shared, "no game is shared with the held-out candidates",
          f"{len(shared):,} shared")
    say()

    say(f"  games contributing  {len(games):,} "
        f"({len(rows) / len(games):.2f} positions each)")
    buckets = Counter(bucket_of(r["ply"]) for r in rows)
    say("  ply spread          " + "   ".join(
        f"{name} {buckets[name]:,} ({100 * buckets[name] / len(rows):.1f}%)"
        for name, _, _ in PLY_BUCKETS))
    whites = sum(1 for r in rows if r["fen"].split()[1] == "w")
    say(f"  side to move        w {whites:,} "
        f"({100 * whites / len(rows):.1f}%)  b {len(rows) - whites:,} "
        f"({100 * (len(rows) - whites) / len(rows):.1f}%)")
    plies = sorted(r["ply"] for r in rows)
    say("  ply percentiles     " + "  ".join(
        f"p{p}={pct(plies, p)}" for p in (10, 25, 50, 75, 90, 99))
        + f"  max={plies[-1]}")
    say()
    say(f"  {OUTPUT.name}  {OUTPUT.stat().st_size / 1e6:.1f} MB")
    say(f"  sha256  {digest}")
    say()
    say(f"{sum(checks)}/{len(checks)} checks passed")

    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text("\n".join(lines), encoding="utf-8")
    print(f"\nwritten to {REPORT}")


if __name__ == "__main__":
    main()