"""Tests for the held-out candidate sampling primitives.

Every one of these pins something that would produce a file that looks correct.
A split hash that puts every game on one side, a schedule that only samples
openings, a subset that is really a truncation — none of them raise, none of
them look wrong in the output, and all of them invalidate the held-out numbers
the model is judged on.
"""

import pytest

from build_heldout_candidates import (
    FIRST_PLY,
    GAME_KEEP_ONE_IN,
    MAX_PER_GAME,
    SPLITS,
    STEP_CHOICES,
    choose,
    game_id_of,
    is_accepted,
    ply_schedule,
    split_of,
)

# Real-looking IDs: Lichess uses 8 characters from this alphabet. Fixed rather
# than random so a failure is reproducible.
IDS = [f"{i:08x}"[-8:] for i in range(200_000)]


def first(gen, n):
    return [next(gen) for _ in range(n)]


# -------------------------------------------------------------- the game ID

def test_the_id_is_the_last_path_segment():
    assert game_id_of("https://lichess.org/2xXa7xLj") == "2xXa7xLj"


def test_the_older_host_form_works_too():
    """2013 dumps write http://en.lichess.org/... . If this ever silently
    returned the whole URL, every ID would still hash to something — just to a
    different split than the same game gets from a newer dump."""
    assert game_id_of("http://en.lichess.org/2xXa7xLj") == "2xXa7xLj"


def test_a_trailing_slash_does_not_change_the_id():
    assert game_id_of("https://lichess.org/2xXa7xLj/") == "2xXa7xLj"


# ------------------------------------------------------ acceptance and split

def test_acceptance_keeps_about_one_game_in_sixty_four():
    kept = sum(is_accepted(g) for g in IDS)
    expected = len(IDS) / GAME_KEEP_ONE_IN
    assert 0.9 * expected < kept < 1.1 * expected


def test_accepted_games_reach_both_splits():
    """The one that matters. Acceptance requires v % 64 == 0, which forces
    v % 2 == 0, so splitting on a shared digest's low bit would send every
    accepted game to one split and leave the other empty — and the run would
    finish, and write one full file and one empty one, and report no error."""
    accepted = [g for g in IDS if is_accepted(g)]
    counts = {s: sum(split_of(g) == s for g in accepted) for s in SPLITS}
    assert all(counts[s] > 0.4 * len(accepted) for s in SPLITS), counts


def test_a_game_always_lands_in_the_same_split():
    """Resumability depends on this: a pass that dies and restarts must not move
    a game from validation to test, which would put its near-identical positions
    on both sides of the boundary."""
    for g in IDS[:1000]:
        assert split_of(g) == split_of(g)
        assert split_of(g) in SPLITS


def test_acceptance_is_deterministic():
    assert [is_accepted(g) for g in IDS[:1000]] == [is_accepted(g) for g in IDS[:1000]]


# ------------------------------------------------------------- the schedule

def test_sampling_starts_inside_the_opening_window():
    lo, hi = FIRST_PLY
    starts = {next(ply_schedule(g)) for g in IDS[:5000]}
    assert starts == set(range(lo, hi + 1))


def test_every_gap_is_four_five_or_six():
    """A fixed stride is what this replaces. An even fixed stride would sample
    the same side to move in every single position."""
    for g in IDS[:500]:
        plies = first(ply_schedule(g), 40)
        gaps = {b - a for a, b in zip(plies, plies[1:])}
        assert gaps <= set(STEP_CHOICES), gaps


def test_the_schedule_is_strictly_increasing():
    plies = first(ply_schedule("2xXa7xLj"), 60)
    assert plies == sorted(set(plies))


def test_the_same_game_always_gets_the_same_schedule():
    assert first(ply_schedule("2xXa7xLj"), 30) == first(ply_schedule("2xXa7xLj"), 30)


def test_different_games_get_different_schedules():
    """Otherwise every game in the month is sampled at identical plies, and the
    randomised spacing buys nothing."""
    schedules = {tuple(first(ply_schedule(g), 10)) for g in IDS[:500]}
    assert len(schedules) > 100


# --------------------------------------------------------------- the subset

def records(plies):
    return [{"ply": p, "fen": f"fen-{p}"} for p in plies]


def test_a_short_game_keeps_everything():
    recs = records(first(ply_schedule("2xXa7xLj"), MAX_PER_GAME))
    assert choose(recs, "2xXa7xLj") == recs


def test_a_long_game_is_capped():
    recs = records(first(ply_schedule("2xXa7xLj"), 40))
    kept = choose(recs, "2xXa7xLj")
    assert len(kept) == MAX_PER_GAME
    assert all(r in recs for r in kept)


def test_the_kept_positions_stay_in_ply_order():
    recs = records(first(ply_schedule("2xXa7xLj"), 40))
    kept = choose(recs, "2xXa7xLj")
    assert [r["ply"] for r in kept] == sorted(r["ply"] for r in kept)


def test_the_cap_is_a_subset_not_a_truncation():
    """The endgame test. Keeping the first ten would stop around ply 55 in every
    game, so neither held-out split would contain an endgame and the measured
    error would say nothing about endgame play."""
    for g in IDS[:100]:
        plies = first(ply_schedule(g), 40)
        kept = [r["ply"] for r in choose(records(plies), g)]
        assert max(kept) > plies[MAX_PER_GAME - 1], (g, kept)


def test_the_subset_is_deterministic():
    recs = records(first(ply_schedule("2xXa7xLj"), 40))
    assert choose(recs, "2xXa7xLj") == choose(recs, "2xXa7xLj")


def test_drawing_the_schedule_does_not_disturb_the_subset():
    """Two separately seeded RNGs, not one shared. With one, which positions a
    game keeps would depend on how many it happened to produce, so a game's
    sample would change whenever anything upstream of it changed."""
    recs = records(first(ply_schedule("2xXa7xLj"), 40))
    expected = choose(recs, "2xXa7xLj")
    exhausted = ply_schedule("2xXa7xLj")
    first(exhausted, 500)
    assert choose(recs, "2xXa7xLj") == expected