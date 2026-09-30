"""Tests for the held-out deduplication and selection primitives.

These functions are pure string-and-dict operations — none of them builds a board —
so the fixtures are FEN-shaped strings rather than legal positions, which is
exactly what the functions themselves see. Position legality is CW-161's concern
and is checked there.

What they pin: that the survivor of a duplicate never depends on file order, that a
key shared by both splits ends up in exactly one and that both splits win some of
those ties, and that the cut to 50,000 is uniform with respect to what a position
actually contains.
"""

from itertools import permutations

import pytest

from build_heldout_candidates import SPLITS
from select_heldout import dedupe_within, resolve_across, select


def rec(placement, game_id, ply):
    """One candidate. position_key reads the first three FEN fields, so the key of
    this record is f"{placement} w -"."""
    return {"fen": f"{placement} w - - 0 1", "game_id": game_id, "ply": ply}


def keyed(placements, game_id):
    return dedupe_within([rec(p, game_id, 10) for p in placements])


# ------------------------------------------------------------ dedupe_within

def test_one_record_survives_per_key():
    kept = dedupe_within([rec("A/8", "aaa", 10),
                          rec("A/8", "bbb", 20),
                          rec("B/8", "ccc", 30)])
    assert set(kept) == {"A/8 w -", "B/8 w -"}


def test_the_survivor_is_the_smallest_game_id_then_ply():
    kept = dedupe_within([rec("A/8", "bbb", 10),
                          rec("A/8", "aaa", 40),
                          rec("A/8", "aaa", 20)])
    survivor = kept["A/8 w -"]
    assert (survivor["game_id"], survivor["ply"]) == ("aaa", 20)


def test_the_survivor_does_not_depend_on_input_order():
    """The reason it is min() and not first-seen: file order is an accident, and a
    regenerated candidate file must not quietly swap which copy is in the split."""
    records = [rec("A/8", "bbb", 10), rec("A/8", "aaa", 40), rec("A/8", "aaa", 20)]
    expected = dedupe_within(records)
    for order in permutations(records):
        assert dedupe_within(list(order)) == expected


def test_positions_differing_only_in_clocks_or_en_passant_are_one_position():
    """position_key ignores both fields, so these are a single input to the model —
    keeping both would put the same position in the split twice."""
    a = {"fen": "rnbqkbnr/pp1ppppp/8/2p5/4P3/8/PPPP1PPP/RNBQKBNR w KQkq c6 0 2",
         "game_id": "aaa", "ply": 12}
    b = {"fen": "rnbqkbnr/pp1ppppp/8/2p5/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 9 40",
         "game_id": "bbb", "ply": 14}
    assert len(dedupe_within([a, b])) == 1


# ----------------------------------------------------------- resolve_across

def test_no_key_remains_in_both_splits():
    by_split = {"val": keyed(["A/8", "B/8", "C/8"], "aaa"),
                "test": keyed(["B/8", "C/8", "D/8"], "bbb")}
    resolve_across(by_split)
    assert not set(by_split["val"]) & set(by_split["test"])


def test_a_shared_key_is_kept_by_one_split_not_lost_by_both():
    """Colliding keys are transpositions — the commonest positions in chess — so
    dropping them from both sides would strip those out of the held-out sets."""
    by_split = {"val": keyed(["A/8", "B/8", "C/8"], "aaa"),
                "test": keyed(["B/8", "C/8", "D/8"], "bbb")}
    before = set(by_split["val"]) | set(by_split["test"])
    resolve_across(by_split)
    assert set(by_split["val"]) | set(by_split["test"]) == before


def test_keys_in_only_one_split_are_untouched():
    by_split = {"val": keyed(["A/8", "B/8"], "aaa"),
                "test": keyed(["B/8", "D/8"], "bbb")}
    resolve_across(by_split)
    assert "A/8 w -" in by_split["val"]
    assert "D/8 w -" in by_split["test"]


def test_both_splits_win_some_of_the_ties():
    """A tiebreak that always picked the same side would pass every other check
    here while quietly emptying one split of every transposition it contains."""
    shared = [f"p{i}/8" for i in range(2000)]
    by_split = {"val": keyed(shared, "aaa"), "test": keyed(shared, "bbb")}
    resolve_across(by_split)
    assert len(by_split["val"]) + len(by_split["test"]) == 2000
    assert min(len(by_split["val"]), len(by_split["test"])) > 800


def test_the_winner_depends_only_on_the_key():
    """Not on the game ID or the ply, so the assignment is stable across rebuilds
    of the candidate files."""
    shared = [f"p{i}/8" for i in range(200)]
    first = {"val": keyed(shared, "aaa"), "test": keyed(shared, "bbb")}
    second = {"val": dedupe_within([rec(p, "zzz", 99) for p in shared]),
              "test": dedupe_within([rec(p, "yyy", 55) for p in shared])}
    resolve_across(first)
    resolve_across(second)
    assert set(first["val"]) == set(second["val"])


# ------------------------------------------------------------------- select

def population(n):
    """n records whose plies run 8..207, so a biased cut shows up as a ply skew."""
    return dedupe_within([rec(f"p{i}/8", f"g{i}", 8 + (i % 200)) for i in range(n)])


def test_exactly_n_records_are_returned():
    assert len(select(population(1000), 250)) == 250


def test_the_selection_is_a_subset_of_the_input():
    pool = population(1000)
    chosen = select(pool, 250)
    assert all(r in pool.values() for r in chosen)


def test_too_few_positions_raises_rather_than_returning_a_short_split():
    """A split quietly 3,000 short would invalidate every held-out number that
    cites 50,000, and nothing downstream counts the rows."""
    with pytest.raises(ValueError):
        select(population(100), 250)


def test_the_selection_ignores_input_order():
    pool = population(500)
    shuffled = {k: pool[k] for k in reversed(list(pool))}
    assert select(pool, 100) == select(shuffled, 100)


def test_the_selection_does_not_track_ply():
    """The cut must be uniform with respect to what a position contains. A rank
    correlated with the game's progress would hand over a split systematically
    short of endgames — the same failure the CW-161 cap avoided."""
    pool = population(20_000)
    chosen = select(pool, 5_000)
    all_mean = sum(r["ply"] for r in pool.values()) / len(pool)
    cut_mean = sum(r["ply"] for r in chosen) / len(chosen)
    assert abs(cut_mean - all_mean) < 3