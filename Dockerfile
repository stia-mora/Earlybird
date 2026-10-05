# ═══════════════════════════════════════════════════════════════════════════════
# EarlyBird — Production Dockerfile
# Node.js + Chromium + Python3 + FFmpeg for autonomous AI news pipeline
# ═══════════════════════════════════════════════════════════════════════════════

# Stage 1: Dependencies
FROM node:20-slim AS deps

WORKDIR /app

COPY package.json package-lock.json* ./
COPY prisma ./prisma/

RUN npm ci --omit=dev && npx prisma generate

# Stage 2: Production runtime
FROM node:20-slim AS production

RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    ffmpeg \
    python3 \
    fonts-liberation \
    fonts-noto-cjk \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    xdg-utils \
    wget \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV NODE_ENV=production

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/prisma ./prisma
COPY . .

RUN groupadd -r earlybird && useradd -r -g earlybird -G audio,video earlybird \
    && mkdir -p /home/earlybird/Downloads /app/data/earlybird/media \
    && chown -R earlybird:earlybird /home/earlybird \
    && chown -R earlybird:earlybird /app/data /app/node_modules/@prisma /app/node_modules/.prisma

USER earlybird

HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
    CMD node -e "process.exit(0)"

CMD ["node", "src/earlybird/worker.js"]
