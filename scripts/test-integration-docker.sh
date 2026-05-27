#!/usr/bin/env bash
set -euo pipefail

cleanup() {
  docker compose down
}

trap cleanup EXIT

docker compose up -d --wait

MONGODB_URL="${MONGODB_URL:-mongodb://localhost:27017}" \
REDIS_URL="${REDIS_URL:-redis://localhost:6379}" \
bun run test:integration
