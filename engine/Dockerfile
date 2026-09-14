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
WORKDIR /app
COPY facade/package*.json ./
RUN npm ci --omit=dev
COPY facade/ ./
COPY --from=build /src/build/chesswhisper_engine ./engine/chesswhisper_engine
CMD ["node", "src/index.js"]