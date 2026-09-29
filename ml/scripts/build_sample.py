"""One pass over the evaluation dump, writing a ~1M-record uniform sample.

409,710,113 records go in and roughly 1/KEEP_ONE_IN come out. Every later
question is then answered against a ~100 MB file instead of by rescanning the
whole dump.

Sampling is by hash of the FEN rather than by a random number generator, so the
sample is deterministic, resumable, and independent of the order records arrive
in — and it keys on the same four-field FEN used for deduplication elsewhere.

The original line is written out untouched. Which eval and which PV becomes the
label is a decision this pass exists to inform, not to pre-empt, and keeping
whole lines means that choice can be revisited without another pass.
"""

import hashlib
import sys
import time
from pathlib import Path

import zstandard

from streams import iter_lines

DATA = Path(__file__).resolve().parents[1] / "data"
SOURCE = DATA / "lichess_db_eval.jsonl.zst"
OUTPUT = DATA / "eval_sample.jsonl.zst"

# Published record count is 409,710,113, so 400 gives about 1.02M.
KEEP_ONE_IN = 400
EXPECTED_TOTAL = 409_710_113

FEN_KEY = b'"fen":"'
PROGRESS_EVERY = 5_000_000


def fen_of(line):
    """The FEN bytes, by slicing rather than parsing.

    json.loads on 409M records costs hours to build objects discarded a
    microsecond later. The field is on every line and its value contains no
    quotes, so the slice is safe.
    """
    start = line.find(FEN_KEY)
    if start < 0:
        return None
    start += len(FEN_KEY)
    end = line.find(b'"', start)
    return line[start:end] if end > start else None


def keep(fen):
    digest = hashlib.blake2b(fen, digest_size=8).digest()
    return int.from_bytes(digest, "big") % KEEP_ONE_IN == 0


def main():
    seen = kept = skipped = 0
    started = time.time()

    cctx = zstandard.ZstdCompressor(level=10)
    with open(OUTPUT, "wb") as raw, cctx.stream_writer(raw) as out:
        for line in iter_lines(SOURCE):
            seen += 1
            fen = fen_of(line)
            if fen is None:
                skipped += 1
            elif keep(fen):
                out.write(line + b"\n")
                kept += 1

            if seen % PROGRESS_EVERY == 0:
                elapsed = time.time() - started
                rate = seen / elapsed
                remaining = (EXPECTED_TOTAL - seen) / rate / 60
                print(f"{seen:,} read  {kept:,} kept  "
                      f"{rate:,.0f}/s  ~{remaining:.0f} min left",
                      file=sys.stderr, flush=True)

    elapsed = time.time() - started
    print(f"\nread    {seen:,}")
    print(f"kept    {kept:,}  ({100 * kept / seen:.4f}%)")
    print(f"skipped {skipped:,}  (no fen field)")
    print(f"elapsed {elapsed / 60:.1f} min")
    print(f"output  {OUTPUT.name}  {OUTPUT.stat().st_size / 1e6:.0f} MB")


if __name__ == "__main__":
    main()