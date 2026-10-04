"""Tests for the model's input encoding.

Two of these are here because the failure they catch is invisible downstream. A
wrong square order or an inverted rank walk produces a model that trains, reports
a falling loss, and evaluates nonsense — so the encoder is checked against
python-chess over real positions rather than against hand-written expectations
alone. And the alignment with canonical.position_key is checked against that
function itself, not against a copy of its field list, because the two drifting
apart is what would let a held-out position into training unnoticed.
"""

import hashlib

import chess
import pytest

from canonical import position_key
from encode import (
    CASTLING,
    CATEGORIES,
    CATEGORY,
    EMBED_DIM,
    FEATURES,
    INPUT_SIZE,
    SQUARES,
    encode,
)

START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"


# ------------------------------------------------------------------ the shape

def test_the_start_position_encodes_square_by_square():
    """Both back ranks written out, because this is where a reversed rank walk
    or an off-by-one in the file shows up as something a reader can see."""
    assert encode(START).squares == (
        4, 2, 3, 5, 6, 3, 2, 4,          # rank 1: R N B Q K B N R
        1, 1, 1, 1, 1, 1, 1, 1,          # rank 2: white pawns
        0, 0, 0, 0, 0, 0, 0, 0,          # ranks 3-6 empty
        0, 0, 0, 0, 0, 0, 0, 0,
        0, 0, 0, 0, 0, 0, 0, 0,
        0, 0, 0, 0, 0, 0, 0, 0,
        7, 7, 7, 7, 7, 7, 7, 7,          # rank 7: black pawns
        10, 8, 9, 11, 12, 9, 8, 10,      # rank 8: r n b q k b n r
    )


def test_a1_is_index_zero_and_h8_is_index_sixty_three():
    """The convention the C++ encoder in CW-236 has to match. python-chess and
    chess.hpp both number squares this way; FEN does not."""
    squares = encode(START).squares
    assert squares[chess.A1] == CATEGORY["R"]
    assert squares[chess.E1] == CATEGORY["K"]
    assert squares[chess.H8] == CATEGORY["r"]
    assert squares[chess.E8] == CATEGORY["k"]


def test_the_flattened_input_is_517_values():
    """512 embedding inputs, one side to move, four castling. 517 is a
    consequence of the embedding width, so the arithmetic is pinned rather than
    the number."""
    assert SQUARES * EMBED_DIM + 1 + 4 == INPUT_SIZE == 517
    assert len(encode(START).flat()) == FEATURES == 69


def test_every_category_is_inside_the_embedding_table():
    """An index of 13 into Embedding(13, 8) is an IndexError at training time,
    and an index of -1 silently reads the last row."""
    assert set(CATEGORY.values()) == set(range(1, CATEGORIES))
    assert all(0 <= value < CATEGORIES for value in encode(START).squares)


def test_the_same_fen_always_encodes_to_the_same_values():
    assert encode(START).flat() == encode(START).flat()


# ----------------------------------------------------------------- the fields

def test_four_and_six_field_fens_agree():
    """The same tolerance position_key has, for the same reason: a FEN's tail is
    not part of what the model sees."""
    assert (encode("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq")
            == encode(START))


def test_the_en_passant_square_and_the_clocks_are_not_encoded():
    """Three fields the model has no input for. Keying them apart in the dataset
    would have put one position in training and its twin in a held-out split —
    they are dropped on both sides, together."""
    assert (encode("rnbqkbnr/pp1ppppp/8/2p5/4P3/8/PPPP1PPP/RNBQKBNR w KQkq c6 0 2")
            == encode("rnbqkbnr/pp1ppppp/8/2p5/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 9 40"))


def test_side_to_move_is_one_for_white_and_zero_for_black():
    """CW-233 flips this bit and expects the prediction to negate, so the
    polarity is part of the contract, not an implementation detail."""
    assert encode(START).side_to_move == 1
    assert encode("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR b KQkq - 0 1").side_to_move == 0


def test_side_to_move_is_the_only_thing_it_changes():
    white = encode("r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1")
    black = encode("r3k2r/8/8/8/8/8/8/R3K2R b KQkq - 0 1")
    assert white.squares == black.squares
    assert white.castling == black.castling
    assert white.side_to_move != black.side_to_move


@pytest.mark.parametrize("rights, expected", [
    ("KQkq", (1, 1, 1, 1)),
    ("-", (0, 0, 0, 0)),
    ("Kq", (1, 0, 0, 1)),     # the asymmetric one: a wrong order fails here
    ("Qk", (0, 1, 1, 0)),
])
def test_castling_encodes_in_white_kingside_first_order(rights, expected):
    assert encode(f"r3k2r/8/8/8/8/8/8/R3K2R w {rights} - 0 1").castling == expected
    assert CASTLING == "KQkq"


# -------------------------------------------------------------- the alignment

@pytest.mark.parametrize("a, b", [
    (START, "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq"),
    ("8/8/8/8/8/8/8/K6k w - - 0 1", "8/8/8/8/8/8/8/K6k w - - 99 250"),
    ("rnbqkbnr/pp1ppppp/8/2p5/4P3/8/PPPP1PPP/RNBQKBNR w KQkq c6 0 2",
     "rnbqkbnr/pp1ppppp/8/2p5/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2"),
])
def test_one_key_means_one_encoding(a, b):
    """CW-229's central claim, checked against position_key itself rather than
    against a restatement of its field list. Two positions the model cannot tell
    apart were collapsed into one row — so if they encoded differently, the
    dataset would be collapsing inputs the model can distinguish."""
    assert position_key(a) == position_key(b)
    assert encode(a).flat() == encode(b).flat()


@pytest.mark.parametrize("a, b", [
    ("r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1", "r3k2r/8/8/8/8/8/8/R3K2R w - - 0 1"),
    ("r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1", "r3k2r/8/8/8/8/8/8/R3K2R b KQkq - 0 1"),
    (START, "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1"),
])
def test_two_keys_mean_two_encodings(a, b):
    """The other direction, and the one that matters for leakage: a position the
    model CAN tell apart must have its own key, or deduplication would merge two
    different inputs into one row."""
    assert position_key(a) != position_key(b)
    assert encode(a).flat() != encode(b).flat()


def test_a_colour_mirror_is_a_different_input():
    """What "absolute" means. Under a mover-relative encoding these would be the
    same tensor; here they are different tensors carrying the same target, which
    is what makes mirroring usable as augmentation in the training script."""
    board = chess.Board("rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1")
    assert encode(board.fen()).squares != encode(board.mirror().fen()).squares


# ----------------------------------------------------------------- the oracle

def _positions(plies=120):
    """A deterministic walk through real positions.

    The move is chosen by a hash of the ply rather than by a seeded RNG, for the
    same reason every decision in the pipeline is: the sequence depends on
    nothing but the code, so a failure here reproduces exactly.
    """
    board = chess.Board()
    for ply in range(plies):
        yield board
        if board.is_game_over():
            return
        moves = sorted(board.legal_moves, key=lambda move: move.uci())
        digest = hashlib.blake2b(str(ply).encode(), digest_size=8,
                                 person=b"encode").digest()
        board.push(moves[int.from_bytes(digest, "big") % len(moves)])


def test_every_square_matches_python_chess_over_real_positions():
    """The oracle. A hand-written FEN cannot catch a transposed file and rank, or
    a rank walked in the wrong direction on positions that happen to be
    symmetric — this walks 120 positions and checks all 64 squares of each.

    python-chess numbers PAWN through KING 1 to 6, which is this encoder's PNBRQK
    order, so the expected category is the piece type plus six for Black. That
    agreement is the other thing this test pins: it is why the C++ port needs no
    translation table.
    """
    for board in _positions():
        squares = encode(board.fen()).squares
        for square in chess.SQUARES:
            piece = board.piece_at(square)
            expected = 0 if piece is None else (
                piece.piece_type + (0 if piece.color == chess.WHITE else 6))
            assert squares[square] == expected, f"{square} in {board.fen()}"


def test_side_to_move_and_castling_match_python_chess_over_real_positions():
    """The same walk, for the five binary inputs — so castling rights falling
    away as the game goes on is checked against the rules rather than asserted."""
    for board in _positions():
        encoded = encode(board.fen())
        assert encoded.side_to_move == (1 if board.turn == chess.WHITE else 0)
        assert encoded.castling == (
            int(board.has_kingside_castling_rights(chess.WHITE)),
            int(board.has_queenside_castling_rights(chess.WHITE)),
            int(board.has_kingside_castling_rights(chess.BLACK)),
            int(board.has_queenside_castling_rights(chess.BLACK)),
        )


def test_a_promoted_piece_encodes_as_its_new_type():
    """Nothing in the categories knows a queen was once a pawn, and nothing
    should — but a promotion is the one way a position reaches nine pieces of a
    type, so it is worth one explicit case."""
    squares = encode("Q7/8/8/8/8/8/8/K6k w - - 0 1").squares
    assert squares[chess.A8] == CATEGORY["Q"]
    assert squares[chess.A1] == CATEGORY["K"]


# ------------------------------------------------------------------ malformed

@pytest.mark.parametrize("fen", [
    "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP w KQkq -",            # seven ranks
    "rnbqkbn/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -",    # a rank of seven
    "ppppppppp/8/8/8/8/8/8/K6k w - -",                        # a rank of nine
    "rnbqkbnx/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -",   # unknown piece
    "8/8/8/8/8/8/8/08 w - -",                                 # a zero in a run
    "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR x KQkq -",   # side to move
    "8/8/8/8/8/8/8/8",                                        # too few fields
])
def test_a_malformed_fen_fails_loudly(fen):
    """A placement field that does not describe 64 squares would otherwise encode
    to a plausible-looking board, which is the one parse error worth paying for a
    check to catch."""
    with pytest.raises(ValueError):
        encode(fen)