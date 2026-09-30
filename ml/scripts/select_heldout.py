"""Cuts the two candidate pools to exactly 50,000 clean positions each.

CW-161 wrote 90,009 and 90,002 candidates and deduplicated nothing, because a
position key is a question about two positions and that pass looked at one game at
a time. This is where the question gets asked: duplicates inside a split,
duplicates across the two, then a uniform cut to the specified size.

Every decision here is a hash of the position key or a comparison of
(game_id, ply), so the result depends only on WHICH records exist and never on the
order they are read in. Rebuilding the candidate files reproduces these two exactly.
"""

import hashlib
import json
from collections import Counter
from pathlib import Path

import zstandard

from build_heldout_candidates import OUTPUT as CANDIDATES
from build_heldout_candidates import SPLITS
from canonical import position_key
from streams import iter_lines
REPORT = Path(__file__).resolve().parents[1] / "notes" / "heldout_splits_report.txt"
DATA = Path(__file__).resolve().parents[1] / "data"
OUTPUT = {"val": DATA / "val_positions.jsonl.zst",
          "test": DATA / "test_positions.jsonl.zst"}

TARGET_PER_SPLIT = 50_000

# CW-162 asks for the spread over early, middle and late play — and explicitly
# asks that nothing be rebalanced on the strength of it. Reported, never acted on.
PLY_BUCKETS = (("< 20", 0, 20), ("20-60", 20, 61), ("> 60", 61, 10 ** 6))


def _rank(key, person):
    """A stable 64-bit ordering value for a position key."""
    raw = hashlib.blake2b(key.encode(), digest_size=8, person=person).digest()
    return int.from_bytes(raw, "big")


def dedupe_within(records):
    """One record per position key, keeping the smallest (game_id, ply).

    Smallest rather than first-seen: first-seen depends on the order the file
    happens to be in, so a regenerated candidate file could keep a different copy
    and quietly change what is in the split. WHICH copy survives does not matter;
    that it is always the same one does.
    """
    best = {}
    for record in records:
        key = position_key(record["fen"])
        current = best.get(key)
        if current is None or ((record["game_id"], record["ply"])
                               < (current["game_id"], current["ply"])):
            best[key] = record
    return best


def resolve_across(by_split):
    """Give each key present in both splits to exactly one of them.

    The winner is blake2b(key) % 2 — arbitrary but fixed, and unbiased between the
    splits. The key is dropped from the LOSER, not from both: a key in two
    different games is a transposition, so the colliding keys are the commonest
    positions in chess, and deleting them everywhere would remove those from the
    held-out sets altogether.

    Nothing leaks either way. CW-164's blocklist is the union of both splits, so
    training excludes the key whichever side keeps it.

    Mutates both dicts and returns the set of keys that were in conflict.
    """
    shared = set(by_split[SPLITS[0]]) & set(by_split[SPLITS[1]])
    for key in shared:
        winner = SPLITS[_rank(key, b"tiebreak") % 2]
        for split in SPLITS:
            if split != winner:
                del by_split[split][key]
    return shared


def select(keyed, n):
    """Exactly n of the records, drawn uniformly by hash rank.

    A rank rather than a modulus, because the count has to be exact — a modulus
    gives you roughly n. A hash rather than random.sample, for the reason CW-159
    hashed instead of seeding an RNG: the outcome depends only on which keys exist,
    so it survives a rerun, a resume, or the input being written in another order.
    """
    if len(keyed) < n:
        raise ValueError(f"only {len(keyed):,} positions available, need {n:,}")
    chosen = sorted(keyed, key=lambda key: _rank(key, b"select"))[:n]
    return [keyed[key] for key in chosen]


def load(split):
    """Every candidate CW-161 wrote for one split."""
    return [json.loads(raw) for raw in iter_lines(CANDIDATES[split])]


def bucket_of(ply):
    for name, lo, hi in PLY_BUCKETS:
        if lo <= ply < hi:
            return name
    raise ValueError(f"ply {ply} falls in no bucket")


def main():
    lines, checks = [], []

    def say(text=""):
        print(text)
        lines.append(text)

    def check(ok, label, detail=""):
        checks.append(bool(ok))
        say(f"  [{'PASS' if ok else 'FAIL'}] {label}" + (f"  — {detail}" if detail else ""))

    raw, after_dedupe = {}, {}
    surviving = {}
    for split in SPLITS:
        records = load(split)
        raw[split] = len(records)
        surviving[split] = dedupe_within(records)
        after_dedupe[split] = len(surviving[split])

    # Mutates `surviving`: a key in both splits is deleted from the loser.
    shared = resolve_across(surviving)

    final = {s: select(surviving[s], TARGET_PER_SPLIT) for s in SPLITS}

    for split in SPLITS:
        # Written in game order rather than hash order — the selection is already
        # decided, and a file a human can scan is worth the sort.
        rows = sorted(final[split], key=lambda r: (r["game_id"], r["ply"]))
        # One compressor per file, per the CW-161 lesson: a ZstdCompressor owns a
        # single compression context.
        cctx = zstandard.ZstdCompressor(level=10)
        with open(OUTPUT[split], "wb") as fh, cctx.stream_writer(fh) as out:
            for row in rows:
                out.write((json.dumps(row) + "\n").encode())

    say("CW-162 SELECTION")
    say()
    for split in SPLITS:
        say(f"{split}")
        say(f"  candidates            {raw[split]:,}")
        say(f"  after within-split    {after_dedupe[split]:,}  "
            f"(-{raw[split] - after_dedupe[split]:,} duplicate keys)")
        say(f"  after cross-split     {len(surviving[split]):,}  "
            f"(-{after_dedupe[split] - len(surviving[split]):,} keys to the other split)")
        say(f"  selected              {len(final[split]):,}  "
            f"{OUTPUT[split].stat().st_size / 1e6:.1f} MB")
        say()

    say(f"keys present in both splits : {len(shared):,}  — each given to one side by "
        f"blake2b(key) % 2,")
    say("                              not deleted from both: these are "
        "transpositions, so they are")
    say("                              the commonest positions in chess.")
    say()

    final_keys = {s: [position_key(r["fen"]) for r in final[s]] for s in SPLITS}
    say("CW-162 ACCEPTANCE")
    for split in SPLITS:
        check(len(final[split]) == TARGET_PER_SPLIT,
              f"{split} holds exactly {TARGET_PER_SPLIT:,}", f"{len(final[split]):,}")
        check(len(set(final_keys[split])) == len(final_keys[split]),
              f"no key appears twice within {split}",
              f"{len(final_keys[split]) - len(set(final_keys[split])):,} repeated")
        check(all(r.get("game_id") for r in final[split]),
              f"every {split} record carries its source game ID")
    overlap = set(final_keys["val"]) & set(final_keys["test"])
    check(not overlap, "no key appears in both splits", f"{len(overlap):,} shared")
    say()

    say("SPREAD — reported only. CW-162 asks that nothing be rebalanced on it, and")
    say("nothing is: the cut above is uniform by hash and never looks at the ply.")
    for split in SPLITS:
        counts = Counter(bucket_of(r["ply"]) for r in final[split])
        n = len(final[split])
        say(f"  {split:<5}" + "   ".join(
            f"{name} {counts[name]:,} ({100 * counts[name] / n:.1f}%)"
            for name, _, _ in PLY_BUCKETS))
    for split in SPLITS:
        n = len(final[split])
        w = sum(1 for r in final[split] if r["fen"].split()[1] == "w")
        say(f"  {split:<5}side to move: w {w:,} ({100 * w / n:.1f}%)  "
            f"b {n - w:,} ({100 * (n - w) / n:.1f}%)")
    say()

    say(f"{sum(checks)}/{len(checks)} checks passed")

    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text("\n".join(lines), encoding="utf-8")
    print(f"\nwritten to {REPORT}")


if __name__ == "__main__":
    main()