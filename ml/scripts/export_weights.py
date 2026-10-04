"""Writes a trained MLP to a file the C++ engine can load, and a parity fixture.

CW-235. Two outputs, from one checkpoint and nothing else:

  models/<run>.weights   the network, behind a header that records every shape
  models/<run>_parity.csv  200 positions with their inputs and this model's
                           answers, for the C++ side to check itself against

**The format is generic across MLPs by design.** The header carries the layer
widths and the input mode, so one C++ MlpEvaluator loads model2, model3, model6,
model7, model8 — one hidden layer or three, embedding or one-hot — as different
files rather than as different code. Only a convolutional model (model5) needs a
second class, because a convolution is not a width list.

**The header exists so a mismatched file is rejected rather than misread.** A
weights file is a flat run of floats; nothing about the bytes says whether they
describe 256 units or 187. Without the shapes written down, loading last week's
model into this week's binary produces a model that runs at full speed and
returns confident nonsense, and nothing downstream can detect it.

**The parity fixture is the other half of that.** It carries the 69 encoder
inputs beside the output, so when the C++ disagrees it says WHICH stage
diverged — the encoder, the matrices, or the inverse transform — instead of just
"it plays badly". Encoder parity is the real risk in CW-236: square order,
piece-type order, which castling bit is which, and whether side to move is 1 for
White. encode.py pins all four and the C++ must follow it rather than re-derive
them.

Reproducible from the checkpoint alone: nothing here samples randomly — the 200
positions are chosen by a hash of the FEN, the same way verify_labels.py chooses
its sample.

    python scripts/export_weights.py [run]        # default: model6
"""

import csv
import hashlib
import math
import struct
import sys
from pathlib import Path

import torch

from encode import CATEGORIES, SQUARES, encode
from targets import S, to_cp

ROOT = Path(__file__).resolve().parents[1]
MODELS = ROOT / "models"
DATA = ROOT / "data"

DEFAULT_RUN = "model6"

MAGIC = b"CWNN"
VERSION = 1
FLAG_COUNT = 5          # side to move, then castling K Q k q

# The engine clamps the model's output before returning it. isMateScore in
# search.hpp treats anything past MATE_SCORE - MAX_PLY (29,936) as a proven mate
# and stops deepening, so a net that overshoots into that band makes the search
# print "score mate N" with a meaningless N on a position with no mate in it.
# This is not theoretical: model6's largest validation prediction is 24,357 cp,
# well past the 10,680 it was ever trained toward, because a regression head is
# not bounded by the range of its targets. 15,000 sits above anything the scale
# can legitimately produce and far below 29,936.
CLAMP_CP = 15_000

SAMPLE = 200

# magic, then ten uint32, then one uint32 per hidden layer. All little-endian,
# which is what both x86 and ARM run; a big-endian host would have to swap, and
# the magic is where that would be caught.
HEADER = "<4s10I"


def linear_layers(state):
    """The embedding (or None) and the Linear layers, in definition order.

    A state_dict preserves the order its modules were defined in, so this needs
    no knowledge of the notebook's class. It handles both shapes the notebooks
    produce: a single `hidden.weight`, and a `nn.Sequential` whose entries are
    `hidden.0.weight`, `hidden.2.weight`, ... (the odd indices are the ReLUs).
    """
    embed = state.get("embed.weight")
    layers = []
    for key, value in state.items():
        if key == "embed.weight" or not key.endswith(".weight"):
            continue
        if value.dim() != 2:
            raise ValueError(f"{key} is {value.dim()}-dimensional; this exporter "
                             f"handles Linear and Embedding only, so a "
                             f"convolutional model needs its own format")
        name = key[: -len(".weight")]
        bias = state.get(f"{name}.bias")
        if bias is None:
            raise ValueError(f"{name} has no bias; the C++ reader expects one "
                             f"per layer and would read the next layer's "
                             f"weights as this one's bias")
        layers.append((name, value, bias))
    if len(layers) < 2:
        raise ValueError("expected at least one hidden layer and an output layer")
    return embed, layers


def check(state, config):
    """Shapes, chained end to end, against what the config claims.

    Every one of these has the same failure mode if it is wrong: the export
    succeeds, the engine loads it, and the evaluations are meaningless.
    """
    embed, layers = linear_layers(state)

    if embed is None:
        expected_input = SQUARES * CATEGORIES + FLAG_COUNT
        embed_dim = 0
    else:
        categories, embed_dim = embed.shape
        if categories != CATEGORIES:
            raise ValueError(f"the embedding has {categories} rows, but encode.py "
                             f"produces {CATEGORIES} categories")
        expected_input = SQUARES * embed_dim + FLAG_COUNT

    if layers[0][1].shape[1] != expected_input:
        raise ValueError(f"the first layer takes {layers[0][1].shape[1]} inputs, "
                         f"but this encoding produces {expected_input}")

    size = expected_input
    for name, weight, bias in layers:
        if weight.shape[1] != size:
            raise ValueError(f"{name} takes {weight.shape[1]} inputs after a "
                             f"layer of {size}")
        if bias.shape[0] != weight.shape[0]:
            raise ValueError(f"{name}'s bias is {bias.shape[0]} for "
                             f"{weight.shape[0]} outputs")
        size = weight.shape[0]
    if size != 1:
        raise ValueError(f"the last layer has {size} outputs; an evaluator "
                         f"returns one number")

    # The config is a claim about the model; the tensors are the model. They
    # disagreeing means one of the two is from a different run.
    claimed = config.get("embed_dim")
    if claimed not in (None, embed_dim) and not (claimed is None and embed_dim == 0):
        raise ValueError(f"config says embed_dim {claimed}, tensors say {embed_dim}")
    widths = [weight.shape[0] for _, weight, _ in layers[:-1]]
    hidden = config.get("hidden")
    hidden = [hidden] if isinstance(hidden, int) else list(hidden or [])
    if hidden and hidden != widths:
        raise ValueError(f"config says hidden {hidden}, tensors say {widths}")

    return embed, layers, embed_dim, expected_input, widths


def write_weights(path, embed, layers, embed_dim, input_size, widths, scale):
    """The header, then every tensor as little-endian float32, row-major.

    Order, which the C++ reader must follow exactly:
      1. the embedding, categories x embed_dim   (absent when embed_dim is 0)
      2. for each hidden layer: weight (out x in), then bias (out)
      3. the output layer: weight (1 x in), then bias (1)

    Row-major and (out, in) is PyTorch's own nn.Linear layout, so nothing is
    transposed on the way out and nothing needs transposing on the way in.

    `scale` is passed in rather than read from targets.py, because a run may
    have trained on its own S. See main().
    """
    tensors = []
    if embed is not None:
        tensors.append(embed)
    for _, weight, bias in layers:
        tensors.extend((weight, bias))

    total = sum(t.numel() for t in tensors)
    header = struct.pack(
        HEADER, MAGIC, VERSION, CATEGORIES, embed_dim, SQUARES, FLAG_COUNT,
        input_size, scale, CLAMP_CP, len(widths), total,
    ) + struct.pack(f"<{len(widths)}I", *widths)

    with open(path, "wb") as fh:
        fh.write(header)
        for tensor in tensors:
            fh.write(tensor.detach().to(torch.float32).contiguous()
                     .numpy().tobytes())
    return total


def read_weights(path):
    """Reads back what write_weights wrote — the Python twin of the C++ loader.

    Here so the export can be verified against the checkpoint rather than
    trusted, and so the format has a second implementation that would catch a
    one-field drift in the header.
    """
    raw = Path(path).read_bytes()
    size = struct.calcsize(HEADER)
    (magic, version, categories, embed_dim, squares, flag_count,
     input_size, scale, clamp, hidden_count, total) = struct.unpack(HEADER, raw[:size])

    if magic != MAGIC:
        raise ValueError(f"{path} is not a weights file (magic {magic!r})")
    if version != VERSION:
        raise ValueError(f"{path} is version {version}, this reads {VERSION}")

    widths = struct.unpack(f"<{hidden_count}I", raw[size:size + 4 * hidden_count])
    floats = torch.frombuffer(bytearray(raw[size + 4 * hidden_count:]),
                              dtype=torch.float32)
    if floats.numel() != total:
        raise ValueError(f"{path} declares {total:,} floats and holds "
                         f"{floats.numel():,}")

    at = 0

    def take(*shape):
        nonlocal at
        count = 1
        for dimension in shape:
            count *= dimension
        chunk = floats[at:at + count].reshape(*shape)
        at += count
        return chunk

    embed = take(categories, embed_dim) if embed_dim else None
    hidden, size_in = [], input_size
    for width in widths:
        hidden.append((take(width, size_in), take(width)))
        size_in = width
    out = (take(1, size_in), take(1))

    return {"embed": embed, "hidden": hidden, "out": out, "scale": scale,
            "clamp": clamp, "input_size": input_size, "embed_dim": embed_dim}


def forward(weights, squares, flags):
    """One forward pass from a weights dict — from the file or from a state_dict.

    Written once and used for both, so a difference between them can only be the
    file, never two different implementations of the same arithmetic.
    """
    if weights["embed"] is not None:
        x = weights["embed"][squares].flatten(1)
    else:
        x = torch.nn.functional.one_hot(squares, CATEGORIES).flatten(1).float()
    x = torch.cat([x, flags], dim=1)
    for weight, bias in weights["hidden"]:
        x = torch.relu(x @ weight.T + bias)
    weight, bias = weights["out"]
    return (x @ weight.T + bias).squeeze(1)


def as_weights(embed, layers, embed_dim, input_size, scale):
    """The checkpoint's tensors in the same shape read_weights returns."""
    return {"embed": embed, "hidden": [(w, b) for _, w, b in layers[:-1]],
            "out": (layers[-1][1], layers[-1][2]), "scale": scale,
            "clamp": CLAMP_CP, "input_size": input_size, "embed_dim": embed_dim}


def centipawns(y, scale):
    """The engine's post-processing: the exact inverse, clamped, rounded.

    Not part of the exported weights — it is three lines in the evaluator — but
    the fixture has to carry its result, because that integer is what search
    actually sees.

    `scale` is the run's own S, for the same reason write_weights takes it: the
    fixture must be computed with the scale the header declares, or the parity
    test would be checking the C++ against the wrong arithmetic.
    """
    return torch.clamp(scale * torch.sinh(y), -CLAMP_CP, CLAMP_CP).round().int()


def sample(n):
    """n validation positions, chosen by a hash of the FEN.

    A hash rather than the first n: the file is in (game_id, ply) order, so the
    top of it is one handful of games. The same n on every machine and every
    rerun, for the reason CW-159 hashed rather than seeding an RNG.
    """
    with open(DATA / "final_val.csv", newline="", encoding="utf-8") as fh:
        reader = csv.reader(fh)
        next(reader)
        rows = [(fen, int(target)) for fen, target in reader]
    rows.sort(key=lambda row: hashlib.blake2b(
        row[0].encode(), digest_size=8, person=b"parity").digest())
    return rows[:n]


def main(run=DEFAULT_RUN):
    checkpoint = torch.load(MODELS / f"{run}.pt", weights_only=False)
    state, config = checkpoint["state_dict"], checkpoint["config"]

    embed, layers, embed_dim, input_size, widths = check(state, config)

    # S comes from the CHECKPOINT, not from targets.py. A run may have trained
    # on its own scale — model6_run9 uses 400 — and exporting it under the
    # module's 1000 would have the engine invert it wrongly. That failure is
    # quieter than it sounds: sinh is monotonic, so minimax picks the same moves
    # and the engine looks healthy, while every reported score is inflated and
    # the clamp fires far too often, which DOES change play in won positions.
    scale = int(config.get("S", S))

    weights_path = MODELS / f"{run}.weights"
    total = write_weights(weights_path, embed, layers, embed_dim, input_size,
                          widths, scale)

    print(f"{run}  —  epoch {checkpoint.get('epoch')}, "
          f"{config.get('loss', 'unknown loss')}")
    print(f"  input      {input_size}"
          f"  ({'one-hot' if not embed_dim else f'embedding {embed_dim}'})")
    print(f"  hidden     {widths}")
    print(f"  floats     {total:,}  ({total * 4 / 1024:.1f} KiB)")
    print(f"  scale S    {scale:,}      clamp +-{CLAMP_CP:,} cp"
          + ("" if scale == S else f"   (targets.py holds {S:,})"))
    print(f"  written    {weights_path.name}")
    print(f"  sha256     {hashlib.sha256(weights_path.read_bytes()).hexdigest()}")

    # ---------------------------------------------------------- verification
    rows = sample(SAMPLE)
    encoded = [encode(fen) for fen, _ in rows]
    squares = torch.tensor([e.squares for e in encoded], dtype=torch.long)
    flags = torch.tensor([(e.side_to_move,) + e.castling for e in encoded],
                         dtype=torch.float32)

    from_checkpoint = forward(
        as_weights(embed, layers, embed_dim, input_size, scale), squares, flags)
    from_file = forward(read_weights(weights_path), squares, flags)
    worst = (from_checkpoint - from_file).abs().max().item()
    print(f"\n  checkpoint vs file over {SAMPLE} positions: "
          f"max difference {worst:.2e}  "
          f"[{'PASS' if worst == 0 else 'FAIL'}]")
    if worst:
        raise SystemExit("the file does not reproduce the checkpoint — stop here")

    cp = centipawns(from_file, scale)
    clamped = int((cp.abs() == CLAMP_CP).sum())
    print(f"  predictions {cp.min().item():+,} .. {cp.max().item():+,} cp"
          f"   ({clamped} clamped)")

    # ------------------------------------------------------------- fixture
    parity = MODELS / f"{run}_parity.csv"
    with open(parity, "w", newline="", encoding="utf-8") as fh:
        writer = csv.writer(fh)
        writer.writerow(("fen", "inputs", "y", "cp"))
        for (fen, _), position, y, value in zip(rows, encoded, from_file, cp):
            writer.writerow((fen, " ".join(str(v) for v in position.flat()),
                             f"{y.item():.7f}", int(value)))
    print(f"  fixture    {parity.name}  ({SAMPLE} positions, "
          f"fen + 69 inputs + raw output + centipawns)")

    print(f"""
  FILE FORMAT — what the C++ loader reads, in order. All little-endian.

    char[4]  magic "CWNN"
    uint32   version          {VERSION}
    uint32   categories       {CATEGORIES}        square categories, 0 = empty
    uint32   embed_dim        {embed_dim}        0 means a one-hot input
    uint32   squares          {SQUARES}
    uint32   flag_count       {FLAG_COUNT}         side to move, then K Q k q
    uint32   input_size       {input_size}
    uint32   scale_s          {scale}      the inverse is scale_s * sinh(y)
    uint32   clamp_cp         {CLAMP_CP}
    uint32   hidden_count     {len(widths)}
    uint32   total_floats     {total}
    uint32   widths[{len(widths)}]       {widths}

    float32  embedding        [categories x embed_dim]   (absent if embed_dim 0)
    float32  for each hidden layer: weight [out x in], then bias [out]
    float32  output: weight [1 x in], then bias [1]

  Row-major, (out, in) — PyTorch's own nn.Linear layout, so nothing is
  transposed in either direction. Reject the file if the magic, the version or
  total_floats disagrees; every one of those is a model that would otherwise
  load and evaluate nonsense.
""")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else DEFAULT_RUN)
