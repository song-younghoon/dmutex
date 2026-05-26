# dmutex

A small TypeScript distributed mutex library that can use MongoDB or Redis as its backend.

`DMutex.acquire()` allows only one caller to hold a lock for a given key at a time. Each lock stores an ownership token, so a stale worker cannot release a lock that was later acquired by another worker. Applications can use the same `DMutex` interface while choosing either MongoDB or Redis as the implementation.

## Installation

Bun:

```bash
bun add dmutex
```

Node.js with npm:

```bash
npm install dmutex
```

Node.js with pnpm:

```bash
pnpm add dmutex
```

Node.js with Yarn:

```bash
yarn add dmutex
```

`dmutex` does not force a specific MongoDB or Redis client package as a runtime dependency or peer dependency. Pass in the database client your application already uses.

If you use the official `mongodb`, `redis`, or `ioredis` packages, install the versions you want in your application.

Bun:

```bash
bun add mongodb
bun add redis
```

Node.js with npm:

```bash
npm install mongodb redis
```

Node.js with pnpm:

```bash
pnpm add mongodb redis
```

Node.js with Yarn:

```bash
yarn add mongodb redis
```

Redis compatibility is currently pinned with real package tests for:

- `redis` / `@redis/client`: uses the `sendCommand(args)` path
- `ioredis`: uses the `set(...args)` / `eval(...args)` path

## Usage

### MongoDB

```ts
import { MongoClient } from "mongodb";
import { DMutex } from "dmutex";

const mongoClient = new MongoClient("mongodb://localhost:27017");
await mongoClient.connect();

const dmutex = new DMutex("my-service", mongoClient);
await dmutex.ready();

const lock = await dmutex.acquire("job:daily-report", 60);

if (!lock) {
  // Another process already holds this lock.
  process.exit(0);
}

try {
  // Run protected work.
} finally {
  await lock.release();
  await mongoClient.close();
}
```

### Redis

```ts
import { createClient } from "redis";
import { DMutex } from "dmutex";

const redisClient = createClient({ url: "redis://localhost:6379" });
await redisClient.connect();

const dmutex = new DMutex("my-service", redisClient);

const lock = await dmutex.acquire("job:daily-report", 60);

if (!lock) {
  // Another process already holds this lock.
  process.exit(0);
}

try {
  // Run protected work.
} finally {
  await lock.release();
  await redisClient.close();
}
```

## API

### `new DMutex(serviceName, client, options?)`

Creates a mutex instance for a service.

- `serviceName`: service identifier used for backend-specific namespacing
- `client`: MongoDB or Redis client. `dmutex` detects the backend from the injected client shape.
- `options.defaultTtlSeconds`: default lock TTL. Defaults to 300 seconds.
- `options.backend`: optional explicit backend override, either `mongodb` or `redis`. Use this when a wrapped client matches more than one backend contract.

MongoDB options:

- `options.dbName`: database name. Defaults to `dmutex`.
- `options.collectionName`: collection name. If set, this takes precedence over `collectionPrefix` and `serviceName`.
- `options.collectionPrefix`: collection prefix. Defaults to `_dmutex_`.

Redis options:

- `options.keyPrefix`: Redis key prefix. Defaults to `_dmutex_${serviceName}:`.

MongoDB uses the `_dmutex_${serviceName}` collection in the `dmutex` database by default. Redis uses keys in the `_dmutex_${serviceName}:${key}` format by default.

### `ready()`

```ts
await dmutex.ready();
```

Waits for backend initialization. For MongoDB, this waits for the TTL index to be created. For Redis, this is a no-op. `acquire()`, `lock()`, `unlock()`, and `extend()` also wait for any required initialization internally, but calling `ready()` during application startup surfaces MongoDB initialization failures earlier.

### `acquire(key, ttl?)`

```ts
const lock = await dmutex.acquire("some-key", 300);

if (lock) {
  try {
    // protected work
  } finally {
    await lock.release();
  }
}
```

Attempts to acquire a lock for the given key.

- `key`: lock identifier
- `ttl`: lock TTL in seconds. Defaults to 300 seconds.
- returns: `DMutexLock` when the lock is acquired, or `null` when another holder already owns the key

`DMutexLock` contains:

- `key`: lock key
- `token`: ownership token
- `expiredAt`: current lock expiration time
- `release()`: releases only the lock with the matching ownership token
- `extend(ttl?)`: extends only the active lock with the matching ownership token

### `lock(key, ttl?)`

Deprecated: use `acquire()` instead. `acquire()` returns a lock handle that carries its ownership token and is safer across async boundaries.

```ts
const acquired = await dmutex.lock("some-key", 300);
```

Attempts to acquire a lock for the given key.

- `key`: lock identifier
- `ttl`: lock TTL in seconds. Defaults to 300 seconds.
- returns: `true` when the lock is acquired, or `false` when another holder already owns the key

This is the legacy boolean-style API. New code should prefer `acquire()`, which exposes ownership explicitly.

### `unlock(key, token?)`

Deprecated: prefer `lock.release()` from the lock handle returned by `acquire()`. `unlock(key)` depends on token state stored in the same `DMutex` instance unless a token is provided.

```ts
await dmutex.unlock("some-key");
```

Deletes the lock for the given key. If `token` is provided, only a lock with the matching token is released. Locks acquired through `lock()` can be released with `unlock(key)` from the same `DMutex` instance because the instance keeps the internal token.

### `extend(key, token, ttl?)`

```ts
await dmutex.extend("some-key", lock.token, 300);
```

Extends the TTL for an active lock with the matching token. Returns `true` on success, or `false` when the token does not match or the lock is already expired.

## Backend Behavior and Caveats

MongoDB:

- Lock acquisition uses MongoDB `insertOne()`. Only one document can exist for a given `_id`, so only one concurrent caller can win.
- TTL is handled with the `expiredAt` field and a MongoDB TTL index. MongoDB's TTL monitor runs periodically, so expired locks are not deleted exactly at their expiration time.
- If an expired lock document has not yet been removed by the TTL monitor, a new acquisition attempt checks expiration and atomically attempts takeover.
- Duplicate key conflicts are treated as normal lock contention. Connection, authorization, and other MongoDB errors are thrown to the caller.

Redis:

- Lock acquisition uses `SET key token PX ttl NX`.
- Lock release and extension use Lua `EVAL` scripts to verify the token and run `DEL` or `PEXPIRE` atomically.
- `DMutexLock.expiredAt` is calculated with the client clock. Actual expiration is enforced by Redis TTL.

Common:

- Release and extension verify the ownership token. The safest usage is to call `release()` and `extend()` on the lock handle returned by `acquire()`.
- The package does not import `mongodb`, `redis`, or `ioredis` at runtime. Client implementations are injected by the application.
- Backend detection is structural. MongoDB clients must expose `db()`. Redis clients must expose either `sendCommand(args)` or both `set(...args)` and `eval(...args)`.
- A client that matches multiple backend contracts is rejected because backend selection would be ambiguous. Pass `options.backend` to choose explicitly.
- MongoDB clients must provide `db`, `collection`, `createIndex`, `insertOne`, `updateOne`, and `deleteOne`.
- Redis clients must provide either `sendCommand(args)` or `set(...args)` plus `eval(...args)`.

## Development

Install dependencies:

```bash
bun install
```

Project layout:

```text
src/                 Runtime library source
tests/unit/          Fast tests that do not require external services
tests/integration/   MongoDB and Redis integration tests
docs/                Project planning and maintenance notes
```

Build:

```bash
bun run build
```

Run the default test suite:

```bash
bun run test
```

This runs the fast unit suite only and does not require MongoDB or Redis.

Running `bun test` directly is also safe: integration tests are skipped unless `DMUTEX_INTEGRATION=1` is set.

Run all unit tests explicitly:

```bash
bun run test:unit
```

Run only Redis adapter unit tests:

```bash
bun run test:redis:unit
```

Run only real `redis` and `ioredis` client integration tests:

```bash
bun run test:redis:integration
```

Run only MongoDB integration tests:

```bash
bun run test:mongodb
```

Run all integration tests:

```bash
bun run test:integration
```

The integration suite requires MongoDB and Redis. The default MongoDB URL is `mongodb://localhost:27017`, and the default Redis URL is `redis://localhost:6379`. Set `MONGODB_URL` and `REDIS_URL` to use different endpoints.

```bash
MONGODB_URL=mongodb://localhost:27017 REDIS_URL=redis://localhost:6379 bun run test:integration
```

### Integration Tests with Docker Compose

Start MongoDB and Redis:

```bash
docker compose up -d
```

Run the integration suite against those services:

```bash
MONGODB_URL=mongodb://localhost:27017 REDIS_URL=redis://localhost:6379 bun run test:integration
```

Stop the services:

```bash
docker compose down
```
