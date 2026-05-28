# dmutex

A small TypeScript distributed mutex and semaphore library that can use MongoDB, Redis, PostgreSQL, DynamoDB, or MySQL as its backend.

`DMutex.acquire()` allows only one caller to hold a lock for a given key at a time. Each lock stores an ownership token, so a stale worker cannot release a lock that was later acquired by another worker. `DMutex` is implemented as a single-permit semaphore, and applications can use the same interface while choosing MongoDB, Redis, PostgreSQL, DynamoDB, or MySQL as the implementation.

`DSemaphore.acquire()` allows up to `maxPermits` callers to hold permits for a given key at the same time. Each permit also carries an ownership token and TTL.

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

`dmutex` does not force a specific MongoDB, Redis, PostgreSQL, DynamoDB, or MySQL client package as a runtime dependency or peer dependency. Pass in the database client your application already uses.

If you use the official `mongodb`, `redis`, `ioredis`, `pg`, `@aws-sdk/client-dynamodb`, or `mysql2` packages, install the versions you want in your application.

Bun:

```bash
bun add mongodb
bun add redis
bun add pg
bun add @aws-sdk/client-dynamodb
bun add mysql2
```

Node.js with npm:

```bash
npm install mongodb redis pg @aws-sdk/client-dynamodb mysql2
```

Node.js with pnpm:

```bash
pnpm add mongodb redis pg @aws-sdk/client-dynamodb mysql2
```

Node.js with Yarn:

```bash
yarn add mongodb redis pg @aws-sdk/client-dynamodb mysql2
```

Redis compatibility is currently pinned with real package tests for:

- `redis` / `@redis/client`: uses the `sendCommand(args)` path
- `ioredis`: uses the `set(...args)` / `eval(...args)` path

PostgreSQL compatibility is currently pinned with real package tests for:

- `pg`: uses the `query(text, values)` path

DynamoDB compatibility is currently pinned with real package tests for:

- `@aws-sdk/client-dynamodb`: use a small wrapper that exposes `createTable()`, `describeTable()`, `putItem()`, `deleteItem()`, and `updateItem()`

MySQL compatibility is currently pinned with real package tests for:

- `mysql2/promise`: uses the `execute(sql, values)` path

## Usage

### MongoDB

```ts
import { MongoClient } from "mongodb";
import { DMutex } from "dmutex";

const mongoClient = new MongoClient("mongodb://localhost:27017");
await mongoClient.connect();

const dmutex = new DMutex("my-service", mongoClient);
await dmutex.ready();

const result = await dmutex.run("job:daily-report", async () => {
  // Run protected work.
  return "done";
}, 60);

if (result === null) {
  // Another process already holds this lock.
  process.exit(0);
}

await mongoClient.close();
```

### Redis

```ts
import { createClient } from "redis";
import { DMutex } from "dmutex";

const redisClient = createClient({ url: "redis://localhost:6379" });
await redisClient.connect();

const dmutex = new DMutex("my-service", redisClient);

const result = await dmutex.run("job:daily-report", async () => {
  // Run protected work.
  return "done";
}, 60);

if (result === null) {
  // Another process already holds this lock.
  process.exit(0);
}

await redisClient.close();
```

### PostgreSQL

```ts
import { Pool } from "pg";
import { DMutex } from "dmutex";

const postgresPool = new Pool({
  connectionString: "postgres://postgres:postgres@localhost:5432/postgres",
});

const dmutex = new DMutex("my-service", postgresPool, {
  backend: "postgresql",
});
await dmutex.ready();

const result = await dmutex.run("job:daily-report", async () => {
  // Run protected work.
  return "done";
}, 60);

if (result === null) {
  // Another process already holds this lock.
  process.exit(0);
}

await postgresPool.end();
```

### DynamoDB

```ts
import {
  CreateTableCommand,
  DeleteItemCommand,
  DescribeTableCommand,
  DynamoDBClient,
  PutItemCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import { DMutex } from "dmutex";

const dynamoDB = new DynamoDBClient({ region: "us-east-1" });

const dmutex = new DMutex("my-service", {
  createTable: async (input) => await dynamoDB.send(new CreateTableCommand(input as any)),
  describeTable: async (input) => await dynamoDB.send(new DescribeTableCommand(input as any)),
  putItem: async (input) => await dynamoDB.send(new PutItemCommand(input as any)),
  deleteItem: async (input) => await dynamoDB.send(new DeleteItemCommand(input as any)),
  updateItem: async (input) => await dynamoDB.send(new UpdateItemCommand(input as any)),
}, {
  backend: "dynamodb",
});
await dmutex.ready();

const result = await dmutex.run("job:daily-report", async () => {
  // Run protected work.
  return "done";
}, 60);

if (result === null) {
  // Another process already holds this lock.
  process.exit(0);
}

dynamoDB.destroy();
```

### MySQL

```ts
import mysql from "mysql2/promise";
import { DMutex } from "dmutex";

const mysqlPool = mysql.createPool("mysql://root:mysql@localhost:3306/dmutex");

const dmutex = new DMutex("my-service", mysqlPool, {
  backend: "mysql",
});
await dmutex.ready();

const result = await dmutex.run("job:daily-report", async () => {
  // Run protected work.
  return "done";
}, 60);

if (result === null) {
  // Another process already holds this lock.
  process.exit(0);
}

await mysqlPool.end();
```

### Semaphore

```ts
import { createClient } from "redis";
import { DSemaphore } from "dmutex";

const redisClient = createClient({ url: "redis://localhost:6379" });
await redisClient.connect();

const semaphore = new DSemaphore("my-service", redisClient, {
  maxPermits: 3,
});

const result = await semaphore.run("api:partner", async (permit) => {
  await permit.extend(120);
  return "done";
}, 120);

if (result === null) {
  // All permits are currently held.
}

await redisClient.close();
```

## API

### `new DMutex(serviceName, client, options?)`

Creates a mutex instance for a service.

- `serviceName`: service identifier used for backend-specific namespacing
- `client`: MongoDB or Redis client. `dmutex` detects the backend from the injected client shape.
- `options.defaultTtlSeconds`: default lock TTL. Defaults to 300 seconds.
- `options.backend`: optional explicit backend override, either `mongodb`, `redis`, `postgresql`, `dynamodb`, or `mysql`. Use this when a wrapped client matches more than one backend contract.

MongoDB options:

- `options.dbName`: database name. Defaults to `dmutex`.
- `options.collectionName`: collection name. If set, this takes precedence over `collectionPrefix` and `serviceName`.
- `options.collectionPrefix`: collection prefix. Defaults to `_dmutex_`.

Redis options:

- `options.keyPrefix`: Redis key prefix. Defaults to `_dmutex_${serviceName}:`.

PostgreSQL options:

- `options.schemaName`: optional table schema. Defaults to the client's current schema.
- `options.tableName`: table name. If set, this takes precedence over `tablePrefix` and `serviceName`.
- `options.tablePrefix`: table prefix. Defaults to `_dmutex_`.

DynamoDB options:

- `options.tableName`: table name. If set, this takes precedence over `tablePrefix` and `serviceName`.
- `options.tablePrefix`: table prefix. Defaults to `_dmutex_`.
- `options.createTable`: whether `ready()` should create the table when missing. Defaults to `true`.
- `options.readyTimeoutMs`: maximum time to wait for the table to become active. Defaults to 30,000 milliseconds.
- `options.readyPollIntervalMs`: delay between table readiness checks. Defaults to 250 milliseconds.

MySQL options:

- `options.databaseName`: optional database name. Defaults to the client's current database.
- `options.tableName`: table name. If set, this takes precedence over `tablePrefix` and `serviceName`.
- `options.tablePrefix`: table prefix. Defaults to `_dmutex_`.

MongoDB uses the `_dmutex_${serviceName}` collection in the `dmutex` database by default. Redis uses keys under the `_dmutex_${serviceName}:` prefix by default. Backend keys include internal permit-slot names.
PostgreSQL uses the `_dmutex_${serviceName}` table by default. Backend keys include internal permit-slot names.
DynamoDB uses the `_dmutex_${serviceName}` table by default. Backend keys include internal permit-slot names.
MySQL uses the `_dmutex_${serviceName}` table by default. Backend keys include internal permit-slot names.

### `ready()`

```ts
await dmutex.ready();
```

Waits for backend initialization. For MongoDB, this waits for the TTL index to be created. For Redis, this is a no-op. `acquire()`, `lock()`, `unlock()`, and `extend()` also wait for any required initialization internally, but calling `ready()` during application startup surfaces MongoDB initialization failures earlier.

### `run(key, callback, ttl?)`

```ts
const result = await dmutex.run("some-key", async (lock) => {
  await lock.extend(300);
  return "done";
}, 300);

if (result === null) {
  // Another process already holds this lock.
}
```

Attempts to acquire a lock, runs the callback while the lock is held, and releases the lock in a `finally` block.

- `key`: lock identifier
- `callback`: function to run while holding the lock. It receives the acquired `DMutexLock`.
- `ttl`: lock TTL in seconds. Defaults to 300 seconds.
- returns: the callback result when the lock is acquired, or `null` when another holder already owns the key

If the callback throws, `run()` releases the lock and rethrows the callback error. `run()` does not automatically renew long-running locks; use the callback's `lock.extend(ttl)` when the protected work may run longer than the TTL.

### `runWithRetry(key, callback, options?)`

```ts
const result = await dmutex.runWithRetry("some-key", async (lock) => {
  return "done";
}, {
  ttl: 300,
  timeoutMs: 10_000,
  retryDelayMs: 100,
});

if (result === null) {
  // The lock was not acquired before timeoutMs elapsed.
}
```

Attempts to acquire a lock until it succeeds or `timeoutMs` elapses, then runs the callback and releases the lock in a `finally` block.

- `options.ttl`: lock TTL in seconds. Defaults to 300 seconds.
- `options.timeoutMs`: maximum time to wait. Defaults to 30,000 milliseconds.
- `options.retryDelayMs`: delay between attempts. Defaults to 100 milliseconds.
- returns: the callback result when the lock is acquired, or `null` when the timeout elapses

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

### `acquireWithRetry(key, options?)`

```ts
const lock = await dmutex.acquireWithRetry("some-key", {
  ttl: 300,
  timeoutMs: 10_000,
  retryDelayMs: 100,
});

if (!lock) {
  // The lock was not acquired before timeoutMs elapsed.
}
```

Attempts to acquire a lock until it succeeds or `timeoutMs` elapses.

- `key`: lock identifier
- `options.ttl`: lock TTL in seconds. Defaults to 300 seconds.
- `options.timeoutMs`: maximum time to wait. Defaults to 30,000 milliseconds.
- `options.retryDelayMs`: delay between attempts. Defaults to 100 milliseconds.
- returns: `DMutexLock` when the lock is acquired, or `null` when the timeout elapses

`DMutexLock` contains:

- `key`: lock key
- `token`: ownership token
- `expiredAt`: current lock expiration time, updated after a successful `lock.extend()`
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

## Semaphore API

### `new DSemaphore(serviceName, client, options)`

Creates a semaphore instance for a service.

- `serviceName`: service identifier used for backend-specific namespacing
- `client`: MongoDB or Redis client. Backend detection is the same as `DMutex`.
- `options.maxPermits`: maximum concurrent permits per key. Must be a positive integer.
- `options.defaultTtlSeconds`, `options.backend`, MongoDB options, and Redis options are the same as `DMutex`.

MongoDB uses the `_dsemaphore_${serviceName}` collection by default. Redis uses `_dsemaphore_${serviceName}:` as the default key prefix. Backend keys include internal permit-slot names. Explicit `collectionName`, `collectionPrefix`, and `keyPrefix` options override these defaults.

### `semaphore.acquire(key, ttl?)`

```ts
const permit = await semaphore.acquire("some-key", 300);

if (permit) {
  try {
    // limited-concurrency work
  } finally {
    await permit.release();
  }
}
```

Attempts to acquire one permit for the given key.

- `key`: semaphore identifier
- `ttl`: permit TTL in seconds. Defaults to 300 seconds.
- returns: `DSemaphorePermit` when a permit is acquired, or `null` when all permits are held

`DSemaphorePermit` contains:

- `key`: original semaphore key
- `token`: ownership token
- `slot`: internal permit slot number
- `expiredAt`: current permit expiration time, updated after a successful `permit.extend()`
- `release()`: releases only this permit
- `extend(ttl?)`: extends only this active permit

### `semaphore.run(key, callback, ttl?)`

Attempts to acquire one permit, runs the callback while the permit is held, and releases the permit in a `finally` block. It returns the callback result, or `null` when all permits are held.

### `semaphore.acquireWithRetry(key, options?)`

Attempts to acquire one permit until it succeeds or `timeoutMs` elapses. The options are the same as `DMutex.acquireWithRetry()`.

### `semaphore.runWithRetry(key, callback, options?)`

Attempts to acquire one permit with retry, runs the callback, and releases the permit in a `finally` block.

### `semaphore.release(key, token)`

Releases the active permit with the matching token for the given key. Returns `true` on success, or `false` when no active permit matches.

### `semaphore.extend(key, token, ttl?)`

Extends the TTL for an active permit with the matching token. Returns `true` on success, or `false` when no active permit matches.

## Backend Behavior and Caveats

MongoDB:

- Permit-slot acquisition uses MongoDB `insertOne()`. Only one document can exist for a given internal slot `_id`, so only one concurrent caller can win each slot.
- TTL is handled with the `expiredAt` field and a MongoDB TTL index. MongoDB's TTL monitor runs periodically, so expired locks are not deleted exactly at their expiration time.
- If an expired lock document has not yet been removed by the TTL monitor, a new acquisition attempt checks expiration and atomically attempts takeover.
- Duplicate key conflicts are treated as normal lock contention. Connection, authorization, and other MongoDB errors are thrown to the caller.

Redis:

- Permit-slot acquisition uses `SET key token PX ttl NX`.
- Release and extension use Lua `EVAL` scripts to verify the token and run `DEL` or `PEXPIRE` atomically.
- `DMutexLock.expiredAt` and `DSemaphorePermit.expiredAt` are calculated with the client clock. Actual expiration is enforced by Redis TTL.

PostgreSQL:

- Permit-slot acquisition uses `INSERT ... ON CONFLICT ... DO UPDATE` and only takes over an existing row when `expired_at <= NOW()`.
- Release and extension verify the token in `DELETE` or `UPDATE` predicates.
- PostgreSQL does not automatically delete expired rows. Expired rows do not block acquisition because each acquisition checks expiration and can atomically take over the row.

DynamoDB:

- Permit-slot acquisition uses conditional `PutItem` and only overwrites an existing item when `expiredAt <= now`.
- Release and extension use conditional `DeleteItem` or `UpdateItem` calls that verify the ownership token.
- DynamoDB TTL cleanup is not required for correctness. Expired items do not block acquisition because each acquisition checks expiration and can atomically take over the item.

MySQL:

- Permit-slot acquisition uses `INSERT ... ON DUPLICATE KEY UPDATE` and only replaces an existing row when `expired_at <= now`.
- Release and extension verify the token in `DELETE` or `UPDATE` predicates.
- MySQL does not automatically delete expired rows. Expired rows do not block acquisition because each acquisition checks expiration and can atomically take over the row.

Common:

- Release and extension verify the ownership token. The safest usage is to call `release()` and `extend()` on the lock handle returned by `acquire()`.
- `DMutex` is backed by `DSemaphore` with `maxPermits: 1`.
- `DSemaphore` is implemented as a fixed set of token-protected internal permit slots. Use the same `maxPermits` for all callers coordinating on the same semaphore key.
- The package does not import `mongodb`, `redis`, `ioredis`, `pg`, `@aws-sdk/client-dynamodb`, or `mysql2` at runtime. Client implementations are injected by the application.
- Backend detection is structural. MongoDB clients must expose `db()`. Redis clients must expose either `sendCommand(args)` or both `set(...args)` and `eval(...args)`. PostgreSQL clients must expose `query(text, values)`. DynamoDB clients must expose `createTable()`, `describeTable()`, `putItem()`, `deleteItem()`, and `updateItem()`. MySQL clients must expose `execute(sql, values)`.
- A client that matches multiple backend contracts is rejected because backend selection would be ambiguous. Pass `options.backend` to choose explicitly.
- MongoDB clients must provide `db`, `collection`, `createIndex`, `insertOne`, `updateOne`, and `deleteOne`.
- Redis clients must provide either `sendCommand(args)` or `set(...args)` plus `eval(...args)`.
- PostgreSQL clients must provide `query(text, values)`.
- DynamoDB clients must provide `createTable`, `describeTable`, `putItem`, `deleteItem`, and `updateItem`.
- MySQL clients must provide `execute(sql, values)`.

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

This runs the fast unit suite only and does not require MongoDB, Redis, PostgreSQL, DynamoDB, or MySQL.

Running `bun test` directly is also safe: integration tests are skipped unless `DMUTEX_INTEGRATION=1` is set.

Run all unit tests explicitly:

```bash
bun run test:unit
```

Run only Redis adapter unit tests:

```bash
bun run test:redis:unit
```

Run only PostgreSQL adapter unit tests:

```bash
bun run test:postgres:unit
```

Run only DynamoDB adapter unit tests:

```bash
bun run test:dynamodb:unit
```

Run only MySQL adapter unit tests:

```bash
bun run test:mysql:unit
```

Run only real `redis` and `ioredis` client integration tests:

```bash
bun run test:redis:integration
```

Run only real `pg` client integration tests:

```bash
bun run test:postgres:integration
```

Run only real DynamoDB Local integration tests:

```bash
bun run test:dynamodb:integration
```

Run only real `mysql2` client integration tests:

```bash
bun run test:mysql:integration
```

Run only MongoDB integration tests:

```bash
bun run test:mongodb
```

Run all integration tests:

```bash
bun run test:integration
```

The integration suite requires MongoDB, Redis, PostgreSQL, DynamoDB Local, and MySQL. The default MongoDB URL is `mongodb://localhost:27017`, the default Redis URL is `redis://localhost:6379`, the default PostgreSQL URL is `postgres://postgres:postgres@localhost:5432/postgres`, the default DynamoDB endpoint is `http://localhost:8000`, and the default MySQL URL is `mysql://root:mysql@localhost:3306/dmutex`. Set `MONGODB_URL`, `REDIS_URL`, `POSTGRES_URL`, `DYNAMODB_ENDPOINT`, and `MYSQL_URL` to use different endpoints.

```bash
MONGODB_URL=mongodb://localhost:27017 REDIS_URL=redis://localhost:6379 POSTGRES_URL=postgres://postgres:postgres@localhost:5432/postgres DYNAMODB_ENDPOINT=http://localhost:8000 MYSQL_URL=mysql://root:mysql@localhost:3306/dmutex bun run test:integration
```

### Integration Tests with Docker Compose

Run the integration suite with Docker Compose-managed MongoDB, Redis, PostgreSQL, DynamoDB Local, and MySQL:

```bash
bun run test:integration:docker
```

This starts the services, waits for their healthchecks, runs the integration tests, and stops the services when the test command exits.
If local port `5432` is already in use, set `POSTGRES_PORT` and the script will pass the matching `POSTGRES_URL` to the integration suite.
If local port `8000` is already in use, set `DYNAMODB_PORT` and the script will pass the matching `DYNAMODB_ENDPOINT` to the integration suite.
If local port `3306` is already in use, set `MYSQL_PORT` and the script will pass the matching `MYSQL_URL` to the integration suite.

```bash
POSTGRES_PORT=5433 DYNAMODB_PORT=8001 MYSQL_PORT=3307 bun run test:integration:docker
```

To manage services manually, start MongoDB, Redis, PostgreSQL, DynamoDB Local, and MySQL:

```bash
docker compose up -d
```

Run the integration suite against those services:

```bash
MONGODB_URL=mongodb://localhost:27017 REDIS_URL=redis://localhost:6379 POSTGRES_URL=postgres://postgres:postgres@localhost:5432/postgres DYNAMODB_ENDPOINT=http://localhost:8000 MYSQL_URL=mysql://root:mysql@localhost:3306/dmutex bun run test:integration
```

Stop the services:

```bash
docker compose down
```
