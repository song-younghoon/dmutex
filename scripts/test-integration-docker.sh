#!/usr/bin/env bash
set -euo pipefail

cleanup() {
  docker compose down
}

trap cleanup EXIT

POSTGRES_PORT="${POSTGRES_PORT:-5432}"
export POSTGRES_PORT

docker compose up -d --wait

MONGODB_URL="${MONGODB_URL:-mongodb://localhost:27017}" \
REDIS_URL="${REDIS_URL:-redis://localhost:6379}" \
POSTGRES_URL="${POSTGRES_URL:-postgres://postgres:postgres@localhost:${POSTGRES_PORT}/postgres}" \
bun run test:integration
