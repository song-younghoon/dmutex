# dmutex

A small TypeScript distributed mutex library that can use MongoDB or Redis as its backend.

`Mutex.acquire()` allows only one caller to hold a lock for a given key at a time. Each lock stores an ownership token, so a stale worker cannot release a lock that was later acquired by another worker. Applications can use the same `Mutex` interface while choosing either MongoDB or Redis as the implementation.

## Installation

```bash
bun add dmutex
```

`dmutex` does not force a specific MongoDB or Redis client package as a runtime dependency or peer dependency. Pass in the database client your application already uses.

If you use the official `mongodb`, `redis`, or `ioredis` packages, install the versions you want in your application.

```bash
bun add mongodb
bun add redis
```

Redis compatibility is currently pinned with real package tests for:

- `redis` / `@redis/client`: uses the `sendCommand(args)` path
- `ioredis`: uses the `set(...args)` / `eval(...args)` path

## Usage

### MongoDB

```ts
import { MongoClient } from "mongodb";
import { Mutex } from "dmutex";

const mongoClient = new MongoClient("mongodb://localhost:27017");
await mongoClient.connect();

const mutex = new Mutex("my-service", mongoClient);
await mutex.ready();

const lock = await mutex.acquire("job:daily-report", 60);

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
import { Mutex } from "dmutex";

const redisClient = createClient({ url: "redis://localhost:6379" });
await redisClient.connect();

const mutex = new Mutex("my-service", redisClient, { backend: "redis" });

const lock = await mutex.acquire("job:daily-report", 60);

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

### `new Mutex(serviceName, client, options?)`

Creates a mutex instance for a service.

- `serviceName`: service identifier used for backend-specific namespacing
- `client`: MongoDB or Redis client
- `options.backend`: backend to use, either `"mongodb"` or `"redis"`. Defaults to `"mongodb"` for backward compatibility.
- `options.defaultTtlSeconds`: default lock TTL. Defaults to 300 seconds.

MongoDB options:

- `options.dbName`: database name. Defaults to `dmutex`.
- `options.collectionName`: collection name. If set, this takes precedence over `collectionPrefix` and `serviceName`.
- `options.collectionPrefix`: collection prefix. Defaults to `_dmutex_`.

Redis options:

- `options.keyPrefix`: Redis key prefix. Defaults to `_dmutex_${serviceName}:`.

MongoDB uses the `_dmutex_${serviceName}` collection in the `dmutex` database by default. Redis uses keys in the `_dmutex_${serviceName}:${key}` format by default.

### `ready()`

```ts
await mutex.ready();
```

Waits for backend initialization. For MongoDB, this waits for the TTL index to be created. For Redis, this is a no-op. `acquire()`, `lock()`, `unlock()`, and `extend()` also wait for any required initialization internally, but calling `ready()` during application startup surfaces MongoDB initialization failures earlier.

### `acquire(key, ttl?)`

```ts
const lock = await mutex.acquire("some-key", 300);

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
- returns: `MutexLock` when the lock is acquired, or `null` when another holder already owns the key

`MutexLock` contains:

- `key`: lock key
- `token`: ownership token
- `expiredAt`: current lock expiration time
- `release()`: releases only the lock with the matching ownership token
- `extend(ttl?)`: extends only the active lock with the matching ownership token

### `lock(key, ttl?)`

```ts
const acquired = await mutex.lock("some-key", 300);
```

Attempts to acquire a lock for the given key.

- `key`: lock identifier
- `ttl`: lock TTL in seconds. Defaults to 300 seconds.
- returns: `true` when the lock is acquired, or `false` when another holder already owns the key

This is the legacy boolean-style API. New code should prefer `acquire()`, which exposes ownership explicitly.

### `unlock(key, token?)`

```ts
await mutex.unlock("some-key");
```

Deletes the lock for the given key. If `token` is provided, only a lock with the matching token is released. Locks acquired through `lock()` can be released with `unlock(key)` from the same `Mutex` instance because the instance keeps the internal token.

### `extend(key, token, ttl?)`

```ts
await mutex.extend("some-key", lock.token, 300);
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
- `MutexLock.expiredAt` is calculated with the client clock. Actual expiration is enforced by Redis TTL.

Common:

- Release and extension verify the ownership token. The safest usage is to call `release()` and `extend()` on the lock handle returned by `acquire()`.
- The package does not import `mongodb`, `redis`, or `ioredis` at runtime. Client implementations are injected by the application.
- MongoDB clients must provide `db`, `collection`, `createIndex`, `insertOne`, `updateOne`, and `deleteOne`.
- Redis clients must provide either `sendCommand(args)` or `set(...args)` plus `eval(...args)`.

## Development

Install dependencies:

```bash
bun install
```

Build:

```bash
bun run build
```

Run all tests:

```bash
bun test
```

Run only Redis adapter unit tests:

```bash
bun run test:redis:unit
```

Run only real `redis` and `ioredis` client integration tests:

```bash
bun run test:redis:integration
```

Run only MongoDB adapter tests:

```bash
bun run test:mongodb
```

The full test suite requires MongoDB and Redis. The default MongoDB URL is `mongodb://localhost:27017`, and the default Redis URL is `redis://localhost:6379`. Set `MONGODB_URL` and `REDIS_URL` to use different endpoints.

```bash
MONGODB_URL=mongodb://localhost:27017 REDIS_URL=redis://localhost:6379 bun test
```
