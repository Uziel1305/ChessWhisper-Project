"""Answers CW-159's 'record shape' and 'which perspective' bullets from the
data rather than the documentation.

The decisive test is at the bottom: group positions where White holds a large
material lead, split by whose turn it is, and look at the mean score. Under a
White-relative convention both groups are strongly positive. Under a
side-to-move convention the black-to-move group flips negative. No amount of
reading the docs settles that; one pass over a few hundred thousand records
does.
"""

import json
from collections import Counter
from pathlib import Path

from streams import iter_lines

EVAL = Path(__file__).resolve().parents[1] / "data" / "lichess_db_eval.jsonl.zst"
LIMIT = 200_000

PIECE_CP = {"p": 100, "n": 320, "b": 330, "r": 500, "q": 900}


def white_material_lead(placement):
    """White material minus Black material, from the FEN placement field."""
    lead = 0
    for ch in placement:
        v = PIECE_CP.get(ch.lower())
        if v:
            lead += v if ch.isupper() else -v
    return lead


def white_pov(pv):
    """One PV as a single number, mate encoded per CLAUDE.md: sign*(30000-100N)."""
    if "cp" in pv:
        return pv["cp"]
    m = pv["mate"]
    return (1 if m > 0 else -1) * (30000 - 100 * abs(m))


def main():
    n = 0
    evals_len, pvs_len, kinds = Counter(), Counter(), Counter()
    cp_signs, mate_signs = Counter(), Counter()
    deepest_is_first = 0
    pv0_max = Counter()          # (side to move, pvs[0] is the maximum)
    lead = {"w": [], "b": []}
    cp_min, cp_max = 10**9, -10**9
    # |mate| at pvs[0]. sign*(30000 - 100N) collides with the cp clamp at
    # N=100 and inverts past N=300, so the actual distribution decides whether
    # that encoding needs a floor.
    mate_dist = Counter()

    # The same sign counts again, but flipped to the side-to-move orientation
    # target_value actually uses. A skew in the dump's White-relative counts
    # may or may not survive that flip, and only the flipped one matters.
    stm_cp_signs, stm_mate_signs = Counter(), Counter()
    for raw in iter_lines(EVAL):
        if n >= LIMIT:
            break
        rec = json.loads(raw)
        n += 1

        fields = rec["fen"].split(" ")
        placement, stm = fields[0], fields[1]

        evals = rec["evals"]
        evals_len[len(evals)] += 1
        best_i = max(range(len(evals)), key=lambda i: evals[i]["depth"])
        deepest_is_first += (best_i == 0)

        pvs = evals[best_i]["pvs"]
        pvs_len[len(pvs)] += 1
        head = pvs[0]

        if "mate" in head:
            m = head["mate"]
            kinds["mate"] += 1
            # Left exactly as it was so the previous run reproduces. A mate of
            # 0 would land in "-" here, which is why mate_dist counts it
            # separately.
            mate_signs["+" if m > 0 else "-"] += 1
            mate_dist[abs(m)] += 1
            sm = m if stm == "w" else -m
            stm_mate_signs["+" if sm > 0 else "-" if sm < 0 else "0"] += 1
        else:
            kinds["cp"] += 1
            c = head["cp"]
            cp_signs["+" if c > 0 else "-" if c < 0 else "0"] += 1
            cp_min, cp_max = min(cp_min, c), max(cp_max, c)
            sc = c if stm == "w" else -c
            stm_cp_signs["+" if sc > 0 else "-" if sc < 0 else "0"] += 1
            if white_material_lead(placement) >= 300:
                lead[stm].append(c)

        # Only informative when the PVs actually differ.
        scores = [white_pov(p) for p in pvs]
        if len(scores) > 1 and max(scores) != min(scores):
            pv0_max[(stm, scores[0] == max(scores))] += 1

    print(f"records examined       : {n}")
    print(f"evals per record       : {dict(sorted(evals_len.items()))}")
    print(f"pvs in the deepest eval: {dict(sorted(pvs_len.items()))}")
    print(f"deepest eval is evals[0]: {deepest_is_first}/{n} "
          f"({100 * deepest_is_first / n:.1f}%)")
    print(f"score kind at pvs[0]   : {dict(kinds)}")
    print(f"cp signs               : {dict(cp_signs)}  range {cp_min}..{cp_max}")
    print(f"mate signs             : {dict(mate_signs)}")
    # The counts above are White-relative, the dump's own convention. These are
    # the same counts after the flip to side-to-move. If a skew survives it,
    # the training set needs colour-mirroring augmentation to correct it.
    print("\nafter flipping to side-to-move orientation:")
    print(f"  cp signs   : {dict(stm_cp_signs)}")
    print(f"  mate signs : {dict(stm_mate_signs)}")

    # |mate| == 0 encodes to 30000, above isMateScore's 29936 threshold in
    # search.hpp — a value the engine's own evaluator is forbidden to produce.
    if mate_dist:
        total = sum(mate_dist.values())
        print("\nmate distance at pvs[0]:")
        print(f"  max |mate|    : {max(mate_dist)}")
        print(f"  |mate| == 0   : {mate_dist.get(0, 0)}")
        print(f"  |mate| >= 100 : {sum(v for k, v in mate_dist.items() if k >= 100)}"
              f" of {total}")
        print(f"  |mate| >= 300 : {sum(v for k, v in mate_dist.items() if k >= 300)}"
              f" of {total}")
    print("\npvs[0] is the MAXIMUM of its PV list:")
    for stm in ("w", "b"):
        yes, no = pv0_max[(stm, True)], pv0_max[(stm, False)]
        if yes + no:
            print(f"  {stm} to move: {yes}/{yes + no} ({100 * yes / (yes + no):.1f}%)")

    print("\nmean cp where White leads by >=300 material:")
    for stm in ("w", "b"):
        v = lead[stm]
        if v:
            print(f"  {stm} to move: n={len(v)}  mean={sum(v) / len(v):+.0f}")


if __name__ == "__main__":
    main()
    