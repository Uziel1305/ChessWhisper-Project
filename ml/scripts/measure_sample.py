"""Measures the derived sample and reports the numbers CW-160's target scale is
frozen from.

Runs over the 1,023,606 records drawn uniformly from all 409,710,113 in the
dump, rather than over a contiguous slice, so MAX_CP and Y are properties of the
whole file and not of wherever the first 200,000 records happened to come from.

Writes the report to a file as well as printing it: CW-166 asks for it kept
rather than scrolled past, and these constants are quoted in the dataset
metadata.
"""

import json
from array import array
from collections import Counter
from pathlib import Path

from streams import iter_lines

ROOT = Path(__file__).resolve().parents[1]
SAMPLE = ROOT / "data" / "eval_sample.jsonl.zst"
REPORT = ROOT / "notes" / "eval_sample_report.txt"

MATE_STEP = 10

lines = []


def say(text=""):
    print(text)
    lines.append(text)


def pct(values_sorted, p):
    i = min(len(values_sorted) - 1, int(round(p / 100 * (len(values_sorted) - 1))))
    return values_sorted[i]


def main():
    cps, cp_white = array("i"), array("b")
    mates, mate_white = array("i"), array("b")
    keys = set()
    evals_len, pvs_len = Counter(), Counter()
    deepest_is_first = n = 0

    for raw in iter_lines(SAMPLE):
        rec = json.loads(raw)
        n += 1

        fen = rec["fen"]
        keys.add(fen)
        white = fen.split(" ")[1] == "w"

        evals = rec["evals"]
        evals_len[len(evals)] += 1
        best = max(range(len(evals)), key=lambda i: evals[i]["depth"])
        deepest_is_first += best == 0

        pvs = evals[best]["pvs"]
        pvs_len[len(pvs)] += 1
        head = pvs[0]

        if "mate" in head:
            mates.append(head["mate"])
            mate_white.append(1 if white else 0)
        else:
            cps.append(head["cp"])
            cp_white.append(1 if white else 0)

    # ---- the two constants ----------------------------------------------
    MAX_CP = max(abs(c) for c in cps)
    Y = max(abs(m) for m in mates)

    say(f"records          : {n:,}")
    say(f"distinct keys    : {len(keys):,}  "
        f"({n - len(keys):,} duplicates)")
    say(f"evals per record : {dict(sorted(evals_len.items()))}")
    say(f"pvs in deepest   : {dict(sorted(pvs_len.items()))}")
    say(f"deepest is first : {deepest_is_first:,}/{n:,} "
        f"({100 * deepest_is_first / n:.2f}%)")
    say()
    say("CONSTANTS TO FREEZE")
    say(f"  MAX_CP    = {MAX_CP}")
    say(f"  Y         = {Y}")
    say(f"  MATE_STEP = {MATE_STEP}")
    say()

    # The encoding at those constants, so the values can be eyeballed before
    # they are committed to.
    def mate_value(z):
        return (1 if z > 0 else -1) * (MAX_CP + MATE_STEP * (Y - abs(z) + 1))

    say("encoding sign * (MAX_CP + MATE_STEP * (Y - |Z| + 1)):")
    for z in (1, 2, 3, 10, Y - 1, Y):
        say(f"  mate in {z:<4} -> {mate_value(z):>8,}")
    say(f"  gap above MAX_CP for the longest mate: {mate_value(Y) - MAX_CP}")
    say()

    # ---- distributions ---------------------------------------------------
    mate_dist = Counter(abs(m) for m in mates)
    say(f"score kind       : cp {len(cps):,} ({100*len(cps)/n:.1f}%)  "
        f"mate {len(mates):,} ({100*len(mates)/n:.1f}%)")
    say(f"|mate| == 0      : {mate_dist.get(0, 0):,}")
    say(f"|mate| >= 100    : {sum(v for k, v in mate_dist.items() if k >= 100):,}")
    say()

    white_rel, stm_rel = Counter(), Counter()
    for c, w in zip(cps, cp_white):
        white_rel["+" if c > 0 else "-" if c < 0 else "0"] += 1
        v = c if w else -c
        stm_rel["+" if v > 0 else "-" if v < 0 else "0"] += 1
    say(f"cp signs, white-relative : {dict(white_rel)}")
    say(f"cp signs, side-to-move   : {dict(stm_rel)}")

    mw, ms = Counter(), Counter()
    for m, w in zip(mates, mate_white):
        mw["+" if m > 0 else "-"] += 1
        v = m if w else -m
        ms["+" if v > 0 else "-"] += 1
    say(f"mate signs, white-relative : {dict(mw)}")
    say(f"mate signs, side-to-move   : {dict(ms)}")
    say()

    whites = sum(cp_white) + sum(mate_white)
    say(f"white to move    : {whites:,} ({100*whites/n:.1f}%)")
    say(f"black to move    : {n - whites:,} ({100*(n-whites)/n:.1f}%)")
    say()

    # ---- magnitude spread, in pawns, as CW-166 asks --------------------
    mags = sorted(abs(c) for c in cps)
    say("|cp| percentiles :")
    for p in (50, 75, 90, 99, 99.9):
        say(f"  p{p:<5} {pct(mags, p):>7,}")
    say(f"  max    {mags[-1]:>7,}")
    say()

    buckets = Counter()
    for m in mags:
        if m < 50:      buckets["< 0.5"] += 1
        elif m < 150:   buckets["0.5-1.5"] += 1
        elif m < 300:   buckets["1.5-3"] += 1
        elif m < 600:   buckets["3-6"] += 1
        else:           buckets["> 6"] += 1
    buckets["mate"] = len(mates)
    say("magnitude buckets (pawns):")
    for name in ("< 0.5", "0.5-1.5", "1.5-3", "3-6", "> 6", "mate"):
        say(f"  {name:<8} {buckets[name]:>9,}  ({100*buckets[name]/n:5.1f}%)")

    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text("\n".join(lines), encoding="utf-8")
    print(f"\nwritten to {REPORT}")


if __name__ == "__main__":
    main()