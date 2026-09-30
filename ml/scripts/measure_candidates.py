"""Verifies the two held-out candidate files against CW-161's acceptance list.

Reads only the written files, never the dump, so it checks what was actually
produced rather than re-running the logic that produced it — with one exception
that is the point of the exercise: every ply is checked against a regenerated
ply_schedule, which is what proves the 4-6 spacing rule held and that the pass
is reproducible from the game IDs alone.

Writes the report as well as printing it, as CW-159's measurement did.
"""

import json
from collections import Counter, defaultdict
from pathlib import Path

import chess

from build_heldout_candidates import (
    FIRST_PLY,
    MAX_PER_GAME,
    OUTPUT,
    SPLITS,
    ply_schedule,
    split_of,
)
from canonical import position_key
from streams import iter_lines

ROOT = Path(__file__).resolve().parents[1]
REPORT = ROOT / "notes" / "heldout_candidates_report.txt"

lines, checks = [], []


def say(text=""):
    print(text)
    lines.append(text)


def check(ok, label, detail=""):
    checks.append(bool(ok))
    say(f"  [{'PASS' if ok else 'FAIL'}] {label}" + (f"  — {detail}" if detail else ""))


def pct(values_sorted, p):
    i = min(len(values_sorted) - 1, int(round(p / 100 * (len(values_sorted) - 1))))
    return values_sorted[i]


def schedule_contains(game_id, plies):
    """Whether every sampled ply is a member of this game's schedule.

    Stronger than checking the gaps between written plies: a game yielding more
    than MAX_PER_GAME candidates keeps a uniform subset of them, so its written
    gaps are SUMS of 4, 5 and 6. Membership is the property that survives the
    subset, and it also re-derives every ply from the game ID alone — so a pass
    that was not deterministic would fail here.
    """
    wanted = set(plies)
    limit = max(plies)
    schedule = set()
    for ply in ply_schedule(game_id):
        if ply > limit:
            break
        schedule.add(ply)
    return wanted <= schedule


def main():
    per_split = {}

    for split in SPLITS:
        records = [json.loads(raw) for raw in iter_lines(OUTPUT[split])]
        plies_by_game = defaultdict(list)
        keys, side = Counter(), Counter()
        invalid = misassigned = missing = dead = 0
        all_plies = []

        for r in records:
            if not {"fen", "game_id", "ply"} <= r.keys():
                missing += 1
                continue
            plies_by_game[r["game_id"]].append(r["ply"])
            keys[position_key(r["fen"])] += 1
            all_plies.append(r["ply"])
            board = chess.Board(r["fen"])
            # "Has a legal move" is the requirement, because that is all CW-163
            # needs to get a score out of Stockfish. is_game_over() would also
            # reject insufficient material, which is legal, scoreable and real —
            # and was the only thing this check ever caught.
            if not board.is_valid() or not board.legal_moves:
                invalid += 1
            if board.is_insufficient_material():
                dead += 1
            side["w" if board.turn == chess.WHITE else "b"] += 1
            if split_of(r["game_id"]) != split:
                misassigned += 1

        per_split[split] = {
            "records": records, "plies_by_game": plies_by_game, "keys": keys,
            "side": side, "invalid": invalid, "misassigned": misassigned,
            "missing": missing, "dead": dead, "all_plies": sorted(all_plies),
        }

    say("CW-161 ACCEPTANCE")
    say()

    for split in SPLITS:
        d = per_split[split]
        n = len(d["records"])
        games = d["plies_by_game"]
        say(f"{split} — {n:,} candidates from {len(games):,} games")
        check(80_000 <= n <= 100_000, "80,000-100,000 candidates", f"{n:,}")
        check(d["missing"] == 0, "every record carries fen, game_id and ply",
              f"{d['missing']:,} incomplete")
        check(d["invalid"] == 0, "every FEN is legal and has a legal move",
              f"{d['invalid']:,} bad")
        check(all(p == sorted(set(p)) for p in games.values()),
              "each game's plies are unique and ascending")
        check(all(len(p) <= MAX_PER_GAME for p in games.values()),
              f"no game contributes more than {MAX_PER_GAME}")
        check(all(min(p) >= FIRST_PLY[0] for p in games.values()),
              f"nothing sampled before ply {FIRST_PLY[0]}")
        bad = [g for g, p in games.items() if not schedule_contains(g, p)]
        check(not bad, "every ply is a member of its game's 4-6 ply schedule",
              f"{len(bad):,} games disagree")
        check(d["misassigned"] == 0, "every game belongs to this split by hash",
              f"{d['misassigned']:,} misassigned")
        say()

    val_games = set(per_split["val"]["plies_by_game"])
    test_games = set(per_split["test"]["plies_by_game"])
    shared = val_games & test_games
    say("both splits")
    check(not shared, "no game ID appears in both splits", f"{len(shared):,} shared")
    say("  [NOTE] the dump is streamed throughout — open_pgn yields one handle and "
        "CandidateSampler consumes")
    say("         games one at a time at flat memory. Not checkable from the output "
        "files, which is why")
    say("         this is a note and not a check; the build's own report prints how "
        "many games were")
    say("         traversed.")
    say()

    say("WHAT THE SPLITS LOOK LIKE")
    say()
    for split in SPLITS:
        d = per_split[split]
        n = len(d["records"])
        games = d["plies_by_game"]
        dup = n - len(d["keys"])
        say(f"{split}")
        say(f"  candidates per game : {n / len(games):.2f}  "
            f"(distribution {dict(sorted(Counter(len(p) for p in games.values()).items()))})")
        say(f"  side to move        : w {d['side']['w']:,} "
            f"({100 * d['side']['w'] / n:.1f}%)  b {d['side']['b']:,} "
            f"({100 * d['side']['b'] / n:.1f}%)")
        say(f"  duplicate keys      : {dup:,} ({100 * dup / n:.2f}%) — "
            f"transpositions within the split, removed by CW-162")
        say(f"  dead draws          : {d['dead']:,} — insufficient material; legal, "
            f"correctly scored 0.00, kept deliberately")
        ply = d["all_plies"]
        say("  ply percentiles     : " + "  ".join(
            f"p{p}={pct(ply, p)}" for p in (10, 25, 50, 75, 90, 99)) +
            f"  max={ply[-1]}")
        say()

    overlap = set(per_split["val"]["keys"]) & set(per_split["test"]["keys"])
    say(f"positions keyed into BOTH splits : {len(overlap):,} "
        f"({100 * len(overlap) / len(per_split['val']['keys']):.2f}% of val)")
    say("  Different games reaching the same position — the residual a game-level "
        "split cannot")
    say("  prevent. CW-162 gives each of these to one split by hash rather than "
        "deleting it from")
    say("  both: colliding keys are transpositions, so they are the commonest "
        "positions in chess,")
    say("  and dropping them everywhere would strip those out of the held-out sets "
        "altogether.")
    say()

    say(f"{sum(checks)}/{len(checks)} checks passed")

    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text("\n".join(lines), encoding="utf-8")
    print(f"\nwritten to {REPORT}")


if __name__ == "__main__":
    main()