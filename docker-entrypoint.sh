#!/bin/sh
set -e

echo "[entrypoint] Running database migrations..."
npm run db:migrate

echo "[entrypoint] Starting application..."
exec "$@"
