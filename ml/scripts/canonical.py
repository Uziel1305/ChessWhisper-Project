"""The position key and the target scale — the two primitives every split shares.

Defined once and imported everywhere, because a change to either invalidates
every file built downstream.
"""

# ---------------------------------------------------------------- the scale
# Measured over a uniform 1,023,606-row sample of all 409,710,113 records in the
# Lichess evaluation dump (CW-159). FROZEN: never recomputed from whatever data
# is at hand. A pool with a different Y would silently change what every
# previously written target means.
MAX_CP = 20000      # max |cp| in the dump — Lichess's own clamp, exactly symmetric
Y = 68              # max |mate| in the dump; no record at 0, none at 100 or beyond
MATE_STEP = 10


def mate_value(n):
    """A mate in n, as a value on the centipawn scale.

    Runs from 20,010 for mate in 68 up to 20,680 for mate in 1: strictly ordered
    by distance to mate, every value strictly outside the centipawn range, and
    over 9,000 clear of the engine's own isMateScore threshold of 29,936 — so a
    trained evaluator cannot stray into the search's proven-mate band.

    Replaces sign * (30000 - 100 * n), which put mate targets an order of
    magnitude above ordinary evaluations and left mate in 1 just 36 centipawns
    short of that threshold.
    """
    if n == 0 or abs(n) > Y:
        raise ValueError(
            f"mate distance {n} is outside 1..{Y}, the range these constants "
            f"were frozen for. A record from outside the CW-159 sample would "
            f"encode to a value inside the centipawn range, or with an "
            f"inverted sign — so this fails loudly instead."
        )
    return (1 if n > 0 else -1) * (MAX_CP + MATE_STEP * (Y - abs(n) + 1))

def _value(cp, mate):
    """cp clamped into the centipawn range, mate through the scale above it.
    Exactly one must be given.

    The clamp is what keeps the invariant the whole scale rests on: every mate
    target lies strictly outside the centipawn range, mate in 68 being 20,010
    against a ceiling of 20,000. Before it, that invariant held only because the
    Lichess dump happens to clamp at +-20,000 — a property of one data source
    rather than anything this module enforced. mate_value already refuses a
    distance outside its frozen range; this is the same guard on the other entry.

    Clamped rather than raising, for two reasons. Lichess clamps the training
    labels at exactly this value, so both label sources land on one range, and an
    unclamped held-out label would be a number the training data cannot contain —
    the model could never be trained toward it, so it would contribute pure
    artifact to the validation error. And raw_cp keeps what the engine actually
    reported, so nothing is lost and any later revision recomputes from it.

    Measured: the largest |cp| across the 100,000 Stockfish-labeled held-out
    positions is 9,165, so this clamps nothing today. That is what a guard rail
    looks like when it is installed before it is needed rather than after.
    """
    if (cp is None) == (mate is None):
        raise ValueError("give exactly one of cp, mate")
    if cp is not None:
        return max(-MAX_CP, min(MAX_CP, cp))
    return mate_value(mate)


def target_from_white(cp=None, mate=None, *, white_to_move):
    """For labels reported from WHITE's point of view.

    That is the Lichess evaluation dump, established from the data in CW-159
    rather than from its documentation, which does not say.
    """
    value = _value(cp, mate)
    return value if white_to_move else -value


def target_from_side_to_move(cp=None, mate=None):
    """For labels already from the side to move — anything we generate over UCI,
    which defines `score cp` that way and which both Stockfish and our own
    engine follow.

    Two entry points rather than one with a flag, because this asymmetry between
    the label sources is the single most consequential line in the pipeline:
    getting it backwards trains the model to invert its own evaluation, and
    nothing downstream would flag it. A caller has to name which kind it holds.
    """
    return _value(cp, mate)


# ------------------------------------------------------------------ the key
def position_key(fen):
    """Piece placement, side to move and castling rights, from a FEN of any length.

    These are exactly the fields the v1 model can perceive, which is what makes
    them the right key: two positions the model cannot tell apart must not land
    on opposite sides of the train/test boundary, and two it CAN tell apart must
    not be collapsed into one.

    Deliberately NOT the en-passant square — v1 takes no en-passant feature, so
    two positions differing only there are one input, and keying them apart
    would let one into training while its twin sat in a held-out split. Nor the
    halfmove clock or fullmove number, which do not change what the position is.

    Dropping the en-passant field has a second benefit: a four-field FEN from the
    evaluation dump and a six-field one from python-chess key identically with no
    special case, and the two libraries' differing en-passant conventions stop
    mattering at all.
    """
    placement, side_to_move, castling = fen.split()[:3]
    # Sorted so a source emitting the rights in another order cannot produce a
    # different key for the same position. Standard FEN mandates KQkq order and
    # every library here follows it, so this is a no-op today — it costs nothing
    # and closes a silent-divergence mode of exactly the kind the en-passant
    # convention turned out to be.
    return f"{placement} {side_to_move} {''.join(sorted(castling))}"