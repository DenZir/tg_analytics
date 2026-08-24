FROM node:22-bookworm-slim

WORKDIR /app

# Install deps first for better layer caching (better-sqlite3 needs a native build toolchain)
COPY package.json package-lock.json ./
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && npm ci \
    && apt-get purge -y --auto-remove python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY tsconfig.json drizzle.config.ts ./
COPY src ./src

COPY docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh

ENV NODE_ENV=production
EXPOSE 3000

ENTRYPOINT ["./docker-entrypoint.sh"]
# No build step — this project runs straight off TypeScript source via tsx,
# same as its existing pm2 setup (see ecosystem.config.cjs).
CMD ["npx", "tsx", "src/index.ts"]
