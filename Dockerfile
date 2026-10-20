# Multi-stage multi-architecture Dockerfile for SugoiBot (linux/amd64, linux/arm64)

# Stage 1: Build native dependencies
FROM node:22-bookworm-slim AS builder

WORKDIR /app

# Install native compilation toolchain for better-sqlite3
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./

# Install production dependencies only
RUN npm ci --omit=dev

# Stage 2: Minimal runtime image
FROM node:22-bookworm-slim AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000

# Install runtime certificates
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Setup data volume directory with proper permissions for non-root node user
RUN mkdir -p /app/data && chown -R node:node /app

# Copy production node_modules from builder
COPY --from=builder --chown=node:node /app/node_modules ./node_modules

# Copy application source code
COPY --chown=node:node . .

# Run as non-root user
USER node

EXPOSE 3000

# Mount persistent SQLite database directory
VOLUME ["/app/data"]

CMD ["node", "main.js"]
