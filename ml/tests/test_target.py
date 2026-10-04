"""Tests for the training target transform.

The transform's whole claim is that it loses no information — so the round trip
is tested at every magnitude that appears in the dataset, and the ordering is
tested across the boundary between ordinary evaluations and the mate band, which
is where a squash would do damage if it did any.
"""

import math

import pytest

from targets import LANDMARKS, S, to_cp, to_target

SPREAD = [0, 1, 10, 80, 251, 847, 1325, 2863, 9165, 10000, 10010, 10680, 29936]


@pytest.mark.parametrize("cp", SPREAD + [-cp for cp in SPREAD])
def test_the_round_trip_returns_the_original(cp):
    """Exact inverse, so any error in the reported centipawns is the model's."""
    assert to_cp(to_target(cp)) == pytest.approx(cp, rel=1e-9, abs=1e-9)


def test_equality_is_zero_in_both_directions():
    """11.6% of the dump was exactly cp 0 and our own labels carry plenty too, so
    this is a real value, not an edge case."""
    assert to_target(0) == 0.0
    assert to_cp(0.0) == 0.0


@pytest.mark.parametrize("cp", [1, 251, 1325, 10680])
def test_the_transform_is_antisymmetric(cp):
    """asinh(-x) = -asinh(x) exactly, which is why no sign-and-magnitude split or
    epsilon is needed anywhere."""
    assert to_target(-cp) == -to_target(cp)


def test_sign_is_preserved_at_every_magnitude():
    for cp in SPREAD[1:]:
        assert to_target(cp) > 0
        assert to_target(-cp) < 0


def test_strict_ordering_survives_the_squash():
    """Including across the mate boundary: mate in 68 must still outrank the
    largest centipawn value, as it does on the dataset's own scale."""
    ordered = sorted(set([-cp for cp in SPREAD] + SPREAD))
    targets = [to_target(cp) for cp in ordered]
    assert targets == sorted(targets)
    assert all(b > a for a, b in zip(targets, targets[1:]))


def test_one_pawn_is_the_unit():
    """S = 1000 means a pawn, so the transform's linear region is the range games
    are actually decided in."""
    assert to_target(S) == pytest.approx(math.asinh(1))
    assert to_target(S) == pytest.approx(0.8814, abs=5e-5)


def test_the_transform_is_linear_near_equality():
    """Where the classification thresholds live. A 50 cp error near equality has
    to cost roughly what 50 cp means, or the feedback feature is reading noise."""
    assert to_target(50) == pytest.approx(0.050, abs=1e-4)
    # Doubling 50 cp to 100 multiplies the target by 1.9975, not 2.0 — the curve
    # is bending by 0.12% already at a twentieth of a pawn. Pinned at the real
    # number so the test records what the transform does rather than an
    # idealisation of it; the point being made is that the deviation is a tenth
    # of a percent where the thresholds live, not that it is zero.
    assert to_target(100) / to_target(50) == pytest.approx(1.9975, abs=5e-4)


def test_nothing_is_clamped_here():
    """The clamp belongs on the model's output in the engine, not on the label.
    A value past the mate band must still transform, and still order correctly."""
    assert to_target(10 ** 6) > to_target(LANDMARKS["mate in 1"])
    assert math.isfinite(to_target(10 ** 9))


def test_the_recorded_landmarks_are_the_real_ones():
    """These numbers are quoted in CW-230 and read against CW-234's bucketed
    report, so they are pinned rather than trusted."""
    assert to_target(LANDMARKS["median |cp|, train"]) == pytest.approx(0.2484, abs=5e-5)
    assert to_target(LANDMARKS["mate in 68"]) == pytest.approx(2.9992, abs=5e-5)
    assert to_target(LANDMARKS["mate in 1"]) == pytest.approx(3.0637, abs=5e-5)
    assert to_target(LANDMARKS["search's proven-mate band"]) == pytest.approx(4.0925, abs=5e-5)


def test_the_whole_mate_band_is_a_sliver_of_target_space():
    """670 centipawns of deliberate separation collapse to 0.065 in target units.
    Recorded because it is a real consequence of the transform: the model has
    almost no incentive to distinguish mate distances, which is correct for an
    evaluator and is why the search solves mates itself."""
    width = to_target(LANDMARKS["mate in 1"]) - to_target(LANDMARKS["mate in 68"])
    assert width == pytest.approx(0.0645, abs=5e-4)