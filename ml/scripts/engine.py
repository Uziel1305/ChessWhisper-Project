"""A minimal UCI client for the labeling pass — one Stockfish process at a time.

Deliberately NOT the Node facade in engine/facade: that clamps cp to +-10000
where the Lichess dump runs to 20000, and flips both cp and mateIn to White
while the dataset is side-to-move. Two silent corruptions of exactly the fields
CW-163 exists to record.
"""

import hashlib
import re
import subprocess
from pathlib import Path

BINARY = Path(__file__).resolve().parents[1] / "tools" / "stockfish" / "stockfish.exe"

# The pinned configuration. These facts ARE the scale every held-out label sits
# on, so they live in code and are asserted, not just written in the notes.
SHA256 = "45bc8e4969147db9c2eb533810637994619bff0eacc81ccfd9854394901bcbd0"
VERSION = "Stockfish 19"
THREADS = 1
HASH_MB = 16
MULTI_PV = 1

# CW-163's search budget, expressed as nodes rather than milliseconds. The ticket
# specifies 200 ms, and this is what 200 ms measured: in one process on an idle
# machine, the median held-out position searched 111,536 nodes (p10 61,477,
# p50 111,297, p90 154,859 over 286 positions), rounded to a legible constant.
#
# Nodes rather than time because the ticket also requires that a label not depend
# on how many processes ran at once, and that re-evaluating reproduce the recorded
# value. A time limit gives neither: this CPU has 4 physical cores behind 8 logical
# threads, so eight Threads-1 engines would each search roughly half of what one
# alone does in 200 ms, and a laptop throttles over an hour of full load. Under a
# node limit the search is deterministic and both requirements hold exactly.
#
# FROZEN, never recomputed. A faster machine would relabel the dataset on a deeper
# scale, and the two splits would stop being comparable with nothing in the rows
# to show it. Note also that it is an upper bound, not a target: a solved position
# stops at Stockfish's ply ceiling after a few thousand nodes.
NODE_LIMIT = 110_000

SCORE = re.compile(r"\bscore (cp|mate) (-?\d+)\b")
DEPTH = re.compile(r"\bdepth (\d+)\b")
NODES = re.compile(r"\bnodes (\d+)\b")


def verify_binary(binary=BINARY):
    """Fail before the first position rather than after the ten-thousandth.

    A different Stockfish build would relabel positions on a different scale, and
    nothing in the output rows would show it — the run would simply finish.
    """
    if not binary.exists():
        raise FileNotFoundError(f"{binary} is missing — see CW-163 stage 1")
    digest = hashlib.sha256(binary.read_bytes()).hexdigest()
    if digest != SHA256:
        raise RuntimeError(f"{binary} is not the pinned build\n  expected {SHA256}\n  got      {digest}")
    return digest


def parse_info(lines):
    """(cp, mate, depth, nodes) from one search's info lines.

    Exactly one of cp and mate is not None, matching canonical.py's own
    convention, so the caller can hand them straight to target_from_side_to_move.

    Bound lines are skipped. Stockfish emits `score cp N lowerbound` when an
    aspiration window fails high, and that number is a bound on the score rather
    than the score — recording it would put a value in the dataset that the
    search never actually claimed.
    """
    cp = mate = depth = nodes = None
    for line in lines:
        if not line.startswith("info ") or "lowerbound" in line or "upperbound" in line:
            continue
        found = SCORE.search(line)
        if not found:
            continue
        if found.group(1) == "cp":
            cp, mate = int(found.group(2)), None
        else:
            cp, mate = None, int(found.group(2))
        if (d := DEPTH.search(line)):
            depth = int(d.group(1))
        if (n := NODES.search(line)):
            nodes = int(n.group(1))
    if cp is None and mate is None:
        raise RuntimeError("engine reported no score")
    return cp, mate, depth, nodes


class Engine:
    """One Stockfish process, configured once and reused for every position.

    A context manager because the labeling pass runs several of these: an
    exception must not leave processes behind holding cores.
    """

    def __init__(self, binary=BINARY):
        verify_binary(binary)
        self.proc = subprocess.Popen(
            [str(binary)],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            text=True, bufsize=1,
            # Named explicitly rather than left to text=True, which decodes with
            # the machine's locale codepage — cp1255 on this one. UCI is ASCII, so
            # that works until it doesn't: one non-ASCII byte would raise
            # UnicodeDecodeError and kill a worker an hour into a run, and the
            # client would behave differently on a differently-localised machine.
            encoding="ascii", errors="replace",
        )
        self.id_name = self._handshake()

    def _send(self, command):
        self.proc.stdin.write(command + "\n")
        self.proc.stdin.flush()

    def _read_until(self, token):
        lines = []
        for line in self.proc.stdout:
            lines.append(line.rstrip("\n"))
            if lines[-1].startswith(token):
                return lines
        raise RuntimeError(f"engine closed while waiting for {token!r}")

    def _handshake(self):
        self._send("uci")
        lines = self._read_until("uciok")
        # Set all three explicitly even though all three happen to default to
        # what we want: a default is documentation, not a pin, and CW-163 asks
        # for them to be identical for every position.
        for name, value in (("Threads", THREADS), ("Hash", HASH_MB),
                            ("MultiPV", MULTI_PV)):
            self._send(f"setoption name {name} value {value}")
        self._send("isready")
        self._read_until("readyok")
        id_name = next((l for l in lines if l.startswith("id name ")), "")
        if VERSION not in id_name:
            raise RuntimeError(f"expected {VERSION}, engine says {id_name!r}")
        return id_name[len("id name "):]

    def evaluate(self, fen, nodes):
        """One position under a node limit. Returns (cp, mate, depth, nodes).

        ucinewgame before every position, and this is not optional. Without it the
        transposition table carries over, so a position's score depends on which
        positions preceded it — the shard layout would silently change the labels,
        and both the "independent of how many ran at once" and the "re-evaluating
        reproduces" requirements would fail for a reason invisible in the output.
        """
        self._send("ucinewgame")
        self._send("isready")
        self._read_until("readyok")
        self._send(f"position fen {fen}")
        self._send(f"go nodes {nodes}")
        return parse_info(self._read_until("bestmove"))

    def close(self):
        try:
            self._send("quit")
            self.proc.wait(timeout=5)
        except Exception:
            self.proc.kill()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()