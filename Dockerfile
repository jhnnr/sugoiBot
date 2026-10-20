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

# Install runtime certificates, gosu, fontconfig and TrueType fonts for canvas text rendering
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    gosu \
    fontconfig \
    fonts-dejavu-core \
    fonts-noto-color-emoji \
    && fc-cache -fv \
    && rm -rf /var/lib/apt/lists/*

# Create data directory with initial permissions
RUN mkdir -p /app/data && chown -R node:node /app

# Copy production node_modules from builder
COPY --from=builder --chown=node:node /app/node_modules ./node_modules

# Copy application source code
COPY --chown=node:node . .

# Setup entrypoint script for runtime volume permission resolution
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

EXPOSE 3000

# Mount persistent SQLite database directory
VOLUME ["/app/data"]

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["node", "main.js"]
