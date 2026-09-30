"""Tests for the canonical key and target scale.

These pin the two things that are expensive to get wrong and invisible once
wrong: which fields define a position's identity, and which direction each label
source's scores point.
"""

import pytest

from canonical import (
    MATE_STEP,
    MAX_CP,
    Y,
    mate_value,
    position_key,
    target_from_side_to_move,
    target_from_white,
)


# ------------------------------------------------------------------ the key

def test_four_and_six_field_fens_agree():
    """The evaluation dump writes four fields, python-chess writes six. If these
    keyed differently the blocklist would never match, and held-out positions
    would leak into training with nothing anywhere reporting it."""
    assert (position_key("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq")
            == position_key("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"))


def test_clocks_do_not_change_identity():
    assert (position_key("8/8/8/8/8/8/8/K6k w - - 0 1")
            == position_key("8/8/8/8/8/8/8/K6k w - - 99 250"))


def test_en_passant_does_not_change_identity():
    """v1 takes no en-passant feature, so these are one input to the model.
    Keying them apart would put one in training and its twin in a held-out
    split."""
    assert (position_key("rnbqkbnr/pp1ppppp/8/2p5/4P3/8/PPPP1PPP/RNBQKBNR w KQkq c6 0 2")
            == position_key("rnbqkbnr/pp1ppppp/8/2p5/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2"))


def test_castling_rights_do_change_identity():
    """The model does receive castling rights, so it can tell these apart and
    the key must too."""
    assert (position_key("r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1")
            != position_key("r3k2r/8/8/8/8/8/8/R3K2R w - - 0 1"))


def test_side_to_move_changes_identity():
    assert (position_key("r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1")
            != position_key("r3k2r/8/8/8/8/8/8/R3K2R b KQkq - 0 1"))


def test_castling_order_is_normalised():
    """Standard FEN mandates KQkq order and every library here follows it, so
    this can only fail if one stops — which is exactly why it is pinned."""
    assert (position_key("r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1")
            == position_key("r3k2r/8/8/8/8/8/8/R3K2R w qkQK - 0 1"))


# ---------------------------------------------------------------- the scale

def test_mate_in_one_is_the_largest_value_on_the_scale():
    assert mate_value(1) == MAX_CP + MATE_STEP * Y == 20680


def test_the_longest_mate_still_clears_the_centipawn_range():
    """The whole point of the scale: no mate can be mistaken for an ordinary
    evaluation, however distant it is."""
    assert mate_value(Y) == MAX_CP + MATE_STEP == 20010
    assert mate_value(Y) > MAX_CP


def test_shorter_mates_outrank_longer_ones():
    values = [mate_value(n) for n in range(1, Y + 1)]
    assert values == sorted(values, reverse=True)


def test_the_scale_is_symmetric_under_sign():
    for n in (1, 5, Y):
        assert mate_value(-n) == -mate_value(n)


def test_being_mated_is_worse_than_any_centipawn_loss():
    assert mate_value(-Y) < -MAX_CP


@pytest.mark.parametrize("n", [0, Y + 1, -(Y + 1), 100, -300])
def test_mate_outside_the_frozen_range_fails_loudly(n):
    """These constants were frozen from one sample. A record from outside it
    would encode to a value inside the centipawn range, or with an inverted
    sign, and nothing downstream would notice — so it raises instead."""
    with pytest.raises(ValueError):
        mate_value(n)


# ---------------------------------------------------------- the perspective

def test_white_relative_cp_flips_only_for_black():
    assert target_from_white(cp=100, white_to_move=True) == 100
    assert target_from_white(cp=100, white_to_move=False) == -100
    assert target_from_white(cp=-250, white_to_move=True) == -250
    assert target_from_white(cp=-250, white_to_move=False) == 250


def test_white_relative_mate_flips_too():
    """Black to move and `mate: 3` in the dump means WHITE mates in 3 — so the
    side to move is the one being mated, and the target is negative."""
    assert target_from_white(mate=3, white_to_move=False) == -mate_value(3)
    assert target_from_white(mate=-3, white_to_move=False) == mate_value(3)
    assert target_from_white(mate=3, white_to_move=True) == mate_value(3)


def test_uci_labels_are_never_flipped():
    """UCI defines `score cp` from the side to move, so these already point the
    right way. Applying the dump's flip would invert half the validation set."""
    assert target_from_side_to_move(cp=100) == 100
    assert target_from_side_to_move(cp=-100) == -100
    assert target_from_side_to_move(mate=3) == mate_value(3)


def test_the_two_sources_disagree_exactly_where_they_should():
    """The same number from the two sources, Black to move: the entire asymmetry
    in one place."""
    assert target_from_white(cp=100, white_to_move=False) == -100
    assert target_from_side_to_move(cp=100) == 100


def test_zero_cp_is_a_real_value_not_a_missing_one():
    """11.6% of the dump is exactly `cp: 0`. A truthiness check where an
    `is None` check belongs would route every one of them down the mate path."""
    assert target_from_side_to_move(cp=0) == 0
    assert target_from_white(cp=0, white_to_move=False) == 0


@pytest.mark.parametrize("kwargs", [{}, {"cp": 10, "mate": 3}])
def test_exactly_one_of_cp_and_mate(kwargs):
    with pytest.raises(ValueError):
        target_from_side_to_move(**kwargs)