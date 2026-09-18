# ---- build stage: compiles the C++ binary ----
FROM gcc:13-bookworm@sha256:a4c0af1ebfc8f6e98d8faed7c629e3d7c0eaed7cef09f62078d05563cb6ed508 AS build
RUN apt-get update && apt-get install -y --no-install-recommends cmake \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY cpp/ ./cpp/
RUN cmake -S cpp -B build -DCMAKE_BUILD_TYPE=Release \
    && cmake --build build --parallel


# ---- runtime stage: Node facade + the compiled binary beside it ----
FROM node:20-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0
WORKDIR /app
COPY facade/package*.json ./
RUN npm ci --omit=dev
COPY facade/ ./
COPY --from=build /src/build/chesswhisper_engine ./engine/chesswhisper_engine
CMD ["node", "src/index.js"]