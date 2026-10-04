"""A FEN as the model's input: 64 categorical squares, side to move, castling.

v1 encodes **absolutely**. The board is not flipped when Black is to move and
piece colours are not swapped — white and black pieces are separate categories,
and whose turn it is travels as its own input. So the network has to learn that
the same placement means opposite things depending on that one value, where a
mover-relative encoding would hand it that structurally. What it buys is that a
position and its colour mirror are genuinely different inputs carrying the same
target, which makes mirroring real augmentation rather than an identity function
(CW-229; the augmentation itself belongs to the training script).

The fields read here are exactly the fields canonical.position_key keys on, and
that is the property the dataset's leakage guarantee rests on: two positions this
encoder cannot tell apart share a key, so they were collapsed into one row rather
than split across the train/test boundary, and two it can tell apart were never
collapsed. Both sides take the same `fen.split()[:3]` slice so the alignment is
structural rather than a comment asking the reader to trust it. Adding a feature
here — en passant, say — means changing the key too, and regenerating the splits.

Two conventions are pinned for the C++ side (CW-236) rather than for anything
Python cares about: squares are numbered a1 = 0 through h8 = 63, and piece types
run P N B R Q K. Both are what python-chess and the vendored chess.hpp already
use, so the second implementation ports without a transpose or a lookup table. An
encoder that disagrees with this one produces a model that looks trained and
evaluates nonsense, with nothing downstream to flag it — which is why the order
is stated here and tested against python-chess rather than left to be inferred.
"""

from typing import NamedTuple

# chess.hpp's PieceType order: PAWN, KNIGHT, BISHOP, ROOK, QUEEN, KING.
PIECES = "PNBRQK"

SQUARES = 64
CATEGORIES = 13         # empty, six white, six black
EMBED_DIM = 8           # width of the shared square embedding (CW-231)

# 517 written as what it is made of, not as a literal. It is a consequence of the
# embedding width, so a change to EMBED_DIM must not be able to leave the two
# disagreeing — the model's first linear layer is Linear(INPUT_SIZE, 256).
INPUT_SIZE = SQUARES * EMBED_DIM + 1 + 4

# What encode() itself returns: 64 categories, side to move, four castling bits.
# The embedding turns the first 64 into 512 at training time.
FEATURES = SQUARES + 1 + 4

EMPTY = 0
CATEGORY = {letter: 1 + i for i, letter in enumerate(PIECES)}
CATEGORY.update({letter.lower(): 1 + len(PIECES) + i
                 for i, letter in enumerate(PIECES)})

# Four values in this order, every time. A FEN of "-" produces (0, 0, 0, 0) with
# no special case.
CASTLING = "KQkq"

# Explicitly these eight, not str.isdigit(): that accepts "0" — which would leave
# a file unfilled and silently shift the rest of the rank — and also accepts
# superscripts and other unicode digit forms.
RUN = "12345678"


class Encoded(NamedTuple):
    """One position, with the squares kept apart from the binary inputs.

    Not a flat vector of 69, because the two halves go different ways: the 64
    categories pass through the shared embedding and the five flags are
    concatenated after it. Flattening here would only be undone there.
    """

    squares: tuple      # 64 values in 0..12, a1 = 0, b1 = 1, ... h8 = 63
    side_to_move: int   # 1 White to move, 0 Black — CW-233 flips this bit
    castling: tuple     # White kingside, White queenside, Black kingside, Black queenside

    def flat(self):
        """The 69 values in one tuple, squares first. For comparison and export."""
        return self.squares + (self.side_to_move,) + self.castling


def encode(fen):
    """Encode a FEN of four fields or six. Raises ValueError on a malformed one.

    Legality is not checked — that is not this function's job, and every FEN in
    the dataset was written by python-chess. What is checked is that the string
    describes 64 squares, because a placement field that does not is the one
    error that would otherwise encode quietly to a plausible-looking board.
    """
    fields = fen.split()
    if len(fields) < 3:
        raise ValueError(f"a FEN needs at least three fields, got {len(fields)}: {fen!r}")
    placement, side, castling = fields[:3]

    if side not in ("w", "b"):
        raise ValueError(f"side to move is {side!r}, expected 'w' or 'b': {fen!r}")

    rows = placement.split("/")
    if len(rows) != 8:
        raise ValueError(f"placement has {len(rows)} ranks, expected 8: {fen!r}")

    squares = [EMPTY] * SQUARES
    # FEN writes rank 8 first and this numbering starts at rank 1, so the ranks
    # are walked in opposite order to the string. Getting this backwards mirrors
    # every position vertically and is invisible in a trained model's loss.
    for rank, row in zip(range(7, -1, -1), rows):
        file = 0
        for char in row:
            if char in RUN:
                file += int(char)
                continue
            if char not in CATEGORY:
                raise ValueError(f"unknown piece {char!r} in placement: {fen!r}")
            if file > 7:
                raise ValueError(f"rank {rank + 1} overflows 8 files: {fen!r}")
            squares[8 * rank + file] = CATEGORY[char]
            file += 1
        if file != 8:
            raise ValueError(f"rank {rank + 1} fills {file} files, expected 8: {fen!r}")

    return Encoded(
        squares=tuple(squares),
        side_to_move=1 if side == "w" else 0,
        castling=tuple(1 if right in castling else 0 for right in CASTLING),
    )