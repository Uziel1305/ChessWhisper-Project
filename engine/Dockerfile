# ---- build stage: compiles the C++ binary ----
FROM gcc:13-bookworm AS build
RUN apt-get update && apt-get install -y --no-install-recommends cmake \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY cpp/ ./cpp/
RUN cmake -S cpp -B build -DCMAKE_BUILD_TYPE=Release \
    && cmake --build build --parallel


# ---- runtime stage: Node facade + the compiled binary beside it ----
FROM node:20-slim
# Stockfish is the development stand-in behind the facade (CLAUDE.md: "custom
# engine is built behind a Stockfish scaffold"). Debian installs it to
# /usr/games/stockfish. Which binary the facade actually runs is chosen by
# ENGINE_BINARY_PATH in docker-compose.yml, not by anything in this file.
RUN apt-get update && apt-get install -y --no-install-recommends stockfish \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY facade/package*.json ./
RUN npm ci --omit=dev
COPY facade/ ./
COPY --from=build /src/build/chesswhisper_engine ./engine/chesswhisper_engine
CMD ["node", "src/index.js"]