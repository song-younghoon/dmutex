#!/usr/bin/env bash
set -euo pipefail

cleanup() {
  docker compose down
}

trap cleanup EXIT

POSTGRES_PORT="${POSTGRES_PORT:-5432}"
DYNAMODB_PORT="${DYNAMODB_PORT:-8000}"
MYSQL_PORT="${MYSQL_PORT:-3306}"
export POSTGRES_PORT
export DYNAMODB_PORT
export MYSQL_PORT

docker compose up -d --wait

MONGODB_URL="${MONGODB_URL:-mongodb://localhost:27017}" \
REDIS_URL="${REDIS_URL:-redis://localhost:6379}" \
POSTGRES_URL="${POSTGRES_URL:-postgres://postgres:postgres@localhost:${POSTGRES_PORT}/postgres}" \
DYNAMODB_ENDPOINT="${DYNAMODB_ENDPOINT:-http://localhost:${DYNAMODB_PORT}}" \
MYSQL_URL="${MYSQL_URL:-mysql://root:mysql@localhost:${MYSQL_PORT}/dmutex}" \
bun run test:integration
