"""Streaming readers for the two Lichess dumps.

Both are Zstandard-compressed and far larger than memory — the evaluation dump
holds 409,710,113 records. Nothing here decompresses to disk or accumulates:
each function is a generator over a decompressing stream, so memory stays flat
whatever the file size, and stopping early costs nothing, because the rest of
the file is simply never read.
"""

import io

import zstandard

# Bytes pulled from the decompressor at a time. Large enough that per-chunk
# overhead disappears, small enough that memory stays flat.
BUFFER_SIZE = 1 << 20  # 1 MiB


def iter_lines(path):
    """Yield each line of a .zst text file as BYTES, newline stripped.

    Bytes rather than str deliberately: decoding the whole evaluation dump to
    UTF-8 would cost hours for text that is discarded a microsecond later.
    Callers decode only the records they decide to keep.
    """
    dctx = zstandard.ZstdDecompressor()
    with open(path, "rb") as fh, dctx.stream_reader(fh) as reader:
        for line in io.BufferedReader(reader, buffer_size=BUFFER_SIZE):
            yield line.rstrip(b"\r\n")


def iter_games(path):
    """Yield each game of a .pgn.zst as a chess.pgn.Game, one at a time.

    read_game consumes exactly one game and leaves the cursor at the start of
    the next, so games are parsed on demand rather than up front. errors=
    "replace" because player names occasionally carry bytes that are not valid
    UTF-8, and one bad name must not end the stream.
    """
    import chess.pgn

    dctx = zstandard.ZstdDecompressor()
    with open(path, "rb") as fh, dctx.stream_reader(fh) as reader:
        text = io.TextIOWrapper(
            io.BufferedReader(reader, buffer_size=BUFFER_SIZE),
            encoding="utf-8",
            errors="replace",
        )
        while True:
            game = chess.pgn.read_game(text)
            if game is None:  # end of stream
                return
            yield game