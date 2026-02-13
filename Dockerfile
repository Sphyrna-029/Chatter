# Build frontend
FROM node:22-slim AS frontend
WORKDIR /app/client
COPY client/package.json client/package-lock.json ./
RUN npm ci
COPY client/ .
RUN npm run build

# Build backend
FROM rust:1.88-slim AS builder
WORKDIR /app
RUN apt-get update && apt-get install -y pkg-config && rm -rf /var/lib/apt/lists/*
COPY Cargo.toml Cargo.lock ./
RUN mkdir src && echo "fn main() {}" > src/main.rs
RUN cargo build --release && rm -rf src
COPY src/ src/
RUN touch src/main.rs && cargo build --release

# Runtime
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=builder /app/target/release/chatter .
COPY --from=frontend /app/client/dist ./client/dist/

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD curl -f http://localhost:8000/_matrix/client/versions || exit 1

CMD ["./chatter"]
