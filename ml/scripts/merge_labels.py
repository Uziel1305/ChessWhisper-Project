"""Turns the two append logs into the held-out splits' final labeled files.

The logs were written in completion order by imap_unordered, so their row order
depends on which worker finished first — it would differ after a rerun, a resume,
or a change in worker count. This writes them in (game_id, ply) order, the same
order select_heldout.py used for the positions, which is what makes the SHA-256
that CW-164 records a reproducible fact rather than an artifact of scheduling.

It also verifies what nothing has verified yet: that the labeled FENs are exactly
the FENs of the split, and that every stored target_value still equals what
canonical.py computes from the raw fields. The second is an assertion, not a
transformation — the cp clamp added after the run changes no row, since the
largest |cp| across 100,000 positions is 9,165 — and it proves no row came from a
stale code path.
"""

import hashlib
import json
from collections import Counter
from pathlib import Path

import zstandard

from build_heldout_candidates import SPLITS
from canonical import MAX_CP, target_from_side_to_move
from engine import NODE_LIMIT, SHA256, VERSION
from label_heldout import LOG
from select_heldout import OUTPUT as POSITIONS
from streams import iter_lines

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = {s: ROOT / "data" / f"{s}_labeled.jsonl.zst" for s in SPLITS}
REPORT = ROOT / "notes" / "heldout_labels_report.txt"

# Written in this order on every row, so the file is byte-stable and its checksum
# does not depend on dict insertion order.
FIELDS = ("fen", "split", "source_game_id", "ply",
          "target_value", "raw_cp", "raw_mate", "depth", "nodes")

lines, checks = [], []


def say(text=""):
    print(text)
    lines.append(text)


def check(ok, label, detail=""):
    checks.append(bool(ok))
    say(f"  [{'PASS' if ok else 'FAIL'}] {label}" + (f"  — {detail}" if detail else ""))


def pct(sorted_values, p):
    return sorted_values[min(len(sorted_values) - 1, int(p / 100 * (len(sorted_values) - 1)))]


def main():
    say("CW-163 — LABELED HELD-OUT SPLITS")
    say(f"{VERSION}   sha256 {SHA256[:16]}...")
    say(f"Threads 1   Hash 16 MB   MultiPV 1   go nodes {NODE_LIMIT:,}")
    say()

    for split in SPLITS:
        rows = [json.loads(line) for line
                in LOG[split].read_text(encoding="utf-8").splitlines() if line.strip()]
        wanted = {json.loads(raw)["fen"] for raw in iter_lines(POSITIONS[split])}
        labeled = {r["fen"] for r in rows}

        incomplete = sum(1 for r in rows if not all(f in r for f in FIELDS))
        ambiguous = sum(1 for r in rows if (r["raw_cp"] is None) == (r["raw_mate"] is None))
        wrong_split = sum(1 for r in rows if r["split"] != split)
        disagree = sum(1 for r in rows if r["target_value"]
                       != target_from_side_to_move(cp=r["raw_cp"], mate=r["raw_mate"]))
        clamped = sum(1 for r in rows
                      if r["raw_cp"] is not None and abs(r["raw_cp"]) > MAX_CP)
        out_of_range = sum(1 for r in rows if r["raw_cp"] is not None
                           and abs(r["target_value"]) > MAX_CP)

        say(f"{split} — {len(rows):,} rows")
        check(len(rows) == len(wanted), f"exactly {len(wanted):,} rows", f"{len(rows):,}")
        check(len(labeled) == len(rows), "no FEN labeled twice",
              f"{len(rows) - len(labeled):,} repeated")
        check(labeled == wanted, "the labeled FENs are exactly the split's FENs",
              f"{len(wanted - labeled):,} missing, {len(labeled - wanted):,} unexpected")
        check(incomplete == 0, "every row carries all nine fields", f"{incomplete:,} short")
        check(ambiguous == 0, "exactly one of raw_cp and raw_mate per row",
              f"{ambiguous:,} with both or neither")
        check(wrong_split == 0, f"every row is marked {split}", f"{wrong_split:,} wrong")
        check(disagree == 0, "stored target_value equals canonical.py's",
              f"{disagree:,} disagree")
        check(out_of_range == 0, f"no centipawn target exceeds {MAX_CP:,}",
              f"{out_of_range:,} past the ceiling")
        say(f"  rows the cp guard clamped: {clamped:,}")

        rows.sort(key=lambda r: (r["source_game_id"], r["ply"]))
        cctx = zstandard.ZstdCompressor(level=10)
        with open(OUTPUT[split], "wb") as fh, cctx.stream_writer(fh) as out:
            for r in rows:
                out.write((json.dumps({f: r[f] for f in FIELDS}) + "\n").encode())
        digest = hashlib.sha256(OUTPUT[split].read_bytes()).hexdigest()
        say(f"  written {OUTPUT[split].name}  "
            f"{OUTPUT[split].stat().st_size / 1e6:.1f} MB")
        say(f"  sha256  {digest}")

        kinds = Counter("mate" if r["raw_mate"] is not None else "cp" for r in rows)
        cps = sorted(abs(r["raw_cp"]) for r in rows if r["raw_cp"] is not None)
        mates = [abs(r["raw_mate"]) for r in rows if r["raw_mate"] is not None]
        # Depth only over cp rows. A solved mate stops at Stockfish's ply ceiling,
        # so its depth of ~245 means "solved", not "searched deeply" — averaging
        # the two together would make this number say nothing.
        depths = sorted(r["depth"] for r in rows if r["raw_mate"] is None)
        say(f"  score kind : cp {kinds['cp']:,} "
            f"({100 * kinds['cp'] / len(rows):.1f}%)   mate {kinds['mate']:,} "
            f"({100 * kinds['mate'] / len(rows):.1f}%)")
        say(f"  |cp|       : p50 {pct(cps, 50):,}  p90 {pct(cps, 90):,}  "
            f"p99 {pct(cps, 99):,}  max {cps[-1]:,}")
        say(f"  |mate|     : max {max(mates)}  (scale frozen at Y = 68)")
        say(f"  depth (cp) : p10 {pct(depths, 10)}  p50 {pct(depths, 50)}  "
            f"p90 {pct(depths, 90)}")
        say()

    say(f"{sum(checks)}/{len(checks)} checks passed")
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text("\n".join(lines), encoding="utf-8")
    print(f"\nwritten to {REPORT}")


if __name__ == "__main__":
    main()