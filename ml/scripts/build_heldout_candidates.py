"""Draws the validation and test candidate positions from the games dump.

Candidates, not the final splits: CW-162 deduplicates and selects, CW-163
labels with one pinned Stockfish, CW-164 freezes the test set. Nothing here
deduplicates, and nothing here reads canonical.py — a position key is a
question about two positions, and this pass looks at one game at a time.

Everything is keyed off the game ID, so the pass is deterministic, resumable
and independent of the order games arrive in: the same month always produces
the same two files, whichever machine runs it and however often.
"""

import contextlib
import hashlib
import json
import random
import sys
import time
from pathlib import Path

import chess.pgn
import zstandard

from streams import open_pgn

DATA = Path(__file__).resolve().parents[1] / "data"
SOURCE = DATA / "lichess_db_standard_rated_2015-04.pgn.zst"
OUTPUT = {"val": DATA / "val_candidates.jsonl.zst",
          "test": DATA / "test_candidates.jsonl.zst"}

SPLITS = ("val", "test")

# CW-161 asks for 80,000-100,000 candidates per split; 90,000 is the middle.
TARGET_PER_SPLIT = 90_000

# The month holds 1,785,417 games and yields 8.37 candidates per game, so each
# split needs about 10,750 games — 1.2% of the month. Accepting 1 game in 64
# spreads those across the whole of April instead of taking them all from the
# first hours of the 1st: a header-only scan runs at 11,400 games/s against 300
# for a full parse, so traversing everything and full-parsing one game in 64
# costs about three minutes. CW-159 paid for this lesson once already — the
# evaluation dump's first 200,000 records reported 18.4% mates against a true
# 12.4%.
#
# A power of two on purpose: `% 32 == 0` is a strict superset of `% 64 == 0`,
# so if 64 under-delivers, halving it keeps every game already accepted.
GAME_KEEP_ONE_IN = 64

# Plies 0-7 are book positions shared by enormous numbers of games; they would
# dominate both splits and, worse, appear in BOTH, defeating the game-level
# separation this ticket exists to provide. Starting at 8 keeps real opening play
# in the held-out sets — a split with no openings cannot say how the model
# evaluates them — at a measured cost of 0.80% of a split in cross-split
# transpositions against 0.14% for a start at 12, resolved by CW-162 against a
# 40,000-position margin down to the final 50,000.
#
# The window is FOUR plies wide, not five, so two of its starts are even and two
# odd. An odd-sized window is 60/40 on parity, and because a step of 4 or 6
# preserves the side to move while only 5 flips it, that bias decays as (1/3)^k
# rather than vanishing: the five-wide 8-12 window produced 51.1% White in both
# splits. Four wide, the side to move is balanced by construction rather than by
# deleting real positions afterwards.
FIRST_PLY = (8, 11)
STEP_CHOICES = (4, 5, 6)
MAX_PER_GAME = 10

# Counted by streaming the dump and tallying '[Event ' occurrences. Only used to
# report how much of the month the pass covered before both splits filled.
MONTH_GAMES = 1_785_417

PROGRESS_EVERY = 100_000

# read_game returns None at end of stream — so a skipped game's visitor must
# return something else, or the pass would mistake the first uninteresting game
# for the end of the file and stop after a few hundred milliseconds.
SKIPPED = object()


def game_id_of(site):
    """'https://lichess.org/2xXa7xLj' -> '2xXa7xLj'.

    Lichess writes the game's URL into the Site header and nothing else carries
    the ID. Older dumps use 'http://en.lichess.org/...'; the ID is the last path
    segment in either.
    """
    return site.rstrip("/").rsplit("/", 1)[-1]


def _digest(game_id, person):
    """A 64-bit integer from the game ID, distinct per `person`."""
    raw = hashlib.blake2b(game_id.encode(), digest_size=8, person=person).digest()
    return int.from_bytes(raw, "big")


def is_accepted(game_id):
    """Whether this game is parsed at all."""
    return _digest(game_id, b"accept") % GAME_KEEP_ONE_IN == 0


def split_of(game_id):
    """Which split an accepted game belongs to — exactly one, always the same one.

    A SEPARATE digest from is_accepted's, not another slice of one. Acceptance
    requires `v % 64 == 0`, which forces `v % 2 == 0`, so splitting on a shared
    digest's low bit would put every accepted game in one split and leave the
    other empty. Personalising the hash removes the trap rather than navigating
    it; test_heldout_sampling.py pins it.
    """
    return SPLITS[_digest(game_id, b"split") % 2]


def ply_schedule(game_id):
    """The plies to sample from this game: 8-12, then +4, +5 or +6, forever.

    Infinite and deliberately ignorant of the game's length, because the pass
    that consumes it is streaming forward through the moves and does not know
    the length until the game ends. The game's end stops it.

    Randomised spacing rather than a fixed stride: a fixed even stride would
    sample the same side to move every single time, and any fixed stride
    imposes one phase on every game in the split.
    """
    rng = random.Random(game_id)
    ply = rng.randint(*FIRST_PLY)
    while True:
        yield ply
        ply += rng.choice(STEP_CHOICES)


def choose(records, game_id):
    """At most MAX_PER_GAME of one game's candidates, still spanning the game.

    A uniform subset, NOT the first ten: the schedule above reaches ply ~55 in
    ten steps, and the 90th percentile game runs 109 plies, so truncating would
    leave both held-out splits with almost no endgames and the measured error
    would say nothing about endgame play.

    Its own RNG, seeded apart from the schedule's, so how many candidates a game
    happened to produce cannot change which of them are kept.
    """
    if len(records) <= MAX_PER_GAME:
        return records
    rng = random.Random(f"{game_id}:subset")
    return sorted(rng.sample(records, MAX_PER_GAME), key=lambda r: r["ply"])


class CandidateSampler(chess.pgn.BaseVisitor):
    """Samples one game's candidates while the parser walks it.

    A visitor rather than a Game object: read_game's default builds a node per
    move, and this pass keeps 27,900 games out of 1,785,417. Returning SKIP from
    end_headers() drops the rest at the parser's fast path — 11,400 games/s
    against 300 — which is the difference between three minutes and an hour.
    """

    def __init__(self, accept, assign, wanted, stats):
        # The game rules are passed in rather than hardcoded so the training
        # sampler reuses this visitor unchanged. Which positions a game yields is
        # the one thing that must be identical across all three splits, and a
        # second copy of this logic is the obvious way to lose that.
        self.accept = accept          # game_id -> may this game be sampled at all
        self.assign = assign          # game_id -> which output it belongs to
        self.wanted = wanted          # output name -> does it still need positions
        self.stats = stats
        self.site = None
        self.standard = True
        self.game_id = None
        self.split = None
        self.schedule = None
        self.next_ply = None
        self.failed = False
        self.records = []

    def visit_header(self, tagname, tagvalue):
        if tagname == "Site":
            self.site = tagvalue
        elif tagname in ("FEN", "SetUp") or (tagname == "Variant"
                                            and tagvalue != "Standard"):
            # No such game exists in this dump. The guard is for the day someone
            # points this script at a file where one does.
            self.standard = False

    def end_headers(self):
        """Every reason to skip a game is decided here, before a move is parsed."""
        if not self.standard or not self.site:
            return chess.pgn.SKIP
        self.game_id = game_id_of(self.site)
        if not self.accept(self.game_id):
            return chess.pgn.SKIP
        self.split = self.assign(self.game_id)
        if not self.wanted(self.split):
            # This split is already full. Its remaining games cost header speed
            # instead of a full parse, so the tail of the pass runs fast.
            return chess.pgn.SKIP
        self.schedule = ply_schedule(self.game_id)
        self.next_ply = next(self.schedule)
        return None

    def visit_board(self, board):
        """Called for the initial position and after every move, in order."""
        if self.next_ply is None or len(board.move_stack) != self.next_ply:
            return
        # No legal move means checkmate or stalemate — CW-163 cannot ask
        # Stockfish for a score, and it can only ever be a game's final ply.
        if board.legal_moves:
            self.records.append({"fen": board.fen(),
                                 "game_id": self.game_id,
                                 "ply": self.next_ply})
        self.next_ply = next(self.schedule)

    def handle_error(self, error):
        """BaseVisitor's default RAISES. Unhandled, one malformed move in 1.78
        million games would abort the entire pass — and the traceback would point
        at our code rather than at the one game responsible."""
        self.stats["parse_errors"] += 1
        self.failed = True

    def result(self):
        if self.next_ply is None or self.failed:
            return SKIPPED
        return self.split, choose(self.records, self.game_id)


def main():
    counts = {s: 0 for s in SPLITS}        # candidates written
    games_used = {s: 0 for s in SPLITS}    # games that contributed at least one
    stats = {"parse_errors": 0}
    seen = 0
    finished_month = False
    started = time.time()

    def wanted(split):
        return counts[split] < TARGET_PER_SPLIT

    with contextlib.ExitStack() as stack:
        out = {}
        for s in SPLITS:
            raw = stack.enter_context(open(OUTPUT[s], "wb"))
            # One compressor per file. A ZstdCompressor owns a single compression
            # context, so two stream_writers sharing one interleave their frames
            # and corrupt both outputs — the first file loses its frame header
            # altogether. A fresh compressor per split is the way to write two
            # streams at once.
            out[s] = stack.enter_context(
                zstandard.ZstdCompressor(level=10).stream_writer(raw))
        text = stack.enter_context(open_pgn(SOURCE))

        while any(wanted(s) for s in SPLITS):
            outcome = chess.pgn.read_game(
                text, Visitor=lambda: CandidateSampler(
                    is_accepted, split_of, wanted, stats))
            if outcome is None:
                finished_month = True
                break
            seen += 1
            if outcome is not SKIPPED:
                split, records = outcome
                for record in records:
                    out[split].write((json.dumps(record) + "\n").encode())
                counts[split] += len(records)
                if records:
                    games_used[split] += 1

            if seen % PROGRESS_EVERY == 0:
                rate = seen / (time.time() - started)
                print(f"{seen:,} games  val {counts['val']:,}  "
                      f"test {counts['test']:,}  {rate:,.0f} games/s",
                      file=sys.stderr, flush=True)

    elapsed = time.time() - started
    print(f"\ngames read      {seen:,} of {MONTH_GAMES:,} "
          f"({100 * seen / MONTH_GAMES:.0f}% of the month)"
          f"{'  — reached the end' if finished_month else ''}")
    for s in SPLITS:
        per_game = counts[s] / max(games_used[s], 1)
        print(f"{s:<4} candidates {counts[s]:,} from {games_used[s]:,} games "
              f"({per_game:.2f} per game)  "
              f"{OUTPUT[s].stat().st_size / 1e6:.1f} MB")
    print(f"parse errors    {stats['parse_errors']:,}")
    print(f"elapsed         {elapsed / 60:.1f} min")


if __name__ == "__main__":
    main()