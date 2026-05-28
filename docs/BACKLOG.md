# dmutex Backlog

## P0 - Correctness and Safety

### 1. Lock ownership token

- Status: Done
- Problem: `unlock(key)` can delete a lock acquired by another process after the original lock expired.
- Improvement: store a unique token per acquired lock and release only when both `_id` and token match.
- Acceptance criteria:
  - A stale holder cannot release a newer holder's lock.
  - A handle-based API exists for callers that need exact ownership semantics.
  - Legacy `lock(key)`/`unlock(key)` usage remains usable where practical.

### 2. Expired lock takeover

- Status: Done
- Problem: MongoDB TTL cleanup is asynchronous, so expired documents can block new lock attempts until the TTL monitor deletes them.
- Improvement: when duplicate-key insertion fails, atomically replace the document only if `expiredAt <= now`.
- Acceptance criteria:
  - An expired lock can be reacquired without waiting for the MongoDB TTL monitor.
  - Concurrent takeover attempts still allow only one winner.

### 3. Error classification

- Status: Done
- Problem: all MongoDB errors are currently converted to `false`, hiding infrastructure failures.
- Improvement: return `false` only for expected lock contention and rethrow unexpected database errors.
- Acceptance criteria:
  - Duplicate key conflicts are handled as normal lock contention.
  - Connection, auth, validation, and index errors surface to callers.

### 4. Index initialization lifecycle

- Status: Done
- Problem: TTL index creation is fired without awaiting or exposing failures.
- Improvement: store index initialization as a promise and expose an explicit readiness method.
- Acceptance criteria:
  - Lock operations wait for index initialization.
  - Callers can explicitly await `mutex.ready()`.
  - Index creation failures are not swallowed.

## P1 - Packaging and Test Reliability

### 5. Package metadata

- Status: Done
- Problem: package metadata does not explicitly expose types, exports, published files, or test scripts.
- Improvement: add `types`, `exports`, `files`, `test`, and `prepublishOnly` metadata.
- Acceptance criteria:
  - Published package contains intended runtime artifacts only.
  - TypeScript consumers resolve declarations from `dist/index.d.ts`.

### 6. Build output hygiene

- Status: Done
- Problem: tests are compiled into `dist`, causing duplicate test execution.
- Improvement: restrict `tsconfig.json` inputs to runtime source files and exclude tests/output.
- Acceptance criteria:
  - `bun run build` emits only library files.
  - `bun run test` runs source tests once.

### 7. Test environment

- Status: Partially done
- Problem: integration tests require MongoDB/Redis but should fail clearly when backing services are unavailable.
- Improvement: either document a Docker/Testcontainers path or fail fast with clear MongoDB/Redis connection errors.
- Acceptance criteria:
  - Missing MongoDB/Redis produces an actionable failure.
  - CI can run tests repeatably.

### 8. Backend implementation organization

- Status: Done
- Problem: MongoDB, Redis, shared store contracts, and public API code in one file make future backend additions harder to review and maintain.
- Improvement: split public types, store contract, MongoDB store, Redis store, and public `DMutex` API into separate runtime modules.
- Acceptance criteria:
  - `mutex.ts` focuses on the public `DMutex` API.
  - Backend-specific code lives in backend-specific files.
  - Published package still includes all runtime files needed by CommonJS consumers.

## P2 - API Ergonomics and Operations

### 9. Backend abstraction

- Status: Done
- Problem: the project goal is a common distributed-lock interface with selectable backends, but the implementation was tied directly to MongoDB operations.
- Improvement: introduce internal storage adapters and keep `DMutex.acquire()`, `lock()`, `unlock()`, and `extend()` backend-neutral.
- Acceptance criteria:
  - Existing MongoDB constructor usage remains compatible.
  - Redis can be selected through constructor options without changing lock call sites.
  - Ownership-token release and renewal semantics are shared across backends.

### 10. Redis backend

- Status: Done
- Problem: only MongoDB is supported.
- Improvement: add a Redis backend using `SET key token PX ttl NX` for acquisition and Lua `EVAL` scripts for token-protected release/extension.
- Acceptance criteria:
  - Redis lock acquisition allows only one holder per key.
  - Release and extension verify the lock token atomically.
  - Runtime package does not depend on a specific Redis client package.
  - `redis` and `ioredis` clients are covered by type and integration tests.

### 11. Driver-independent client contract

- Status: Done
- Problem: using `mongodb` package types and peer dependencies makes the library appear locked to a specific driver version.
- Improvement: use small structural client interfaces and keep official MongoDB/Redis clients outside runtime dependencies.
- Acceptance criteria:
  - Runtime package has no `mongodb` or `redis` dependency or peer dependency.
  - Public declarations do not import types from `mongodb` or `redis`.
  - Official clients remain compatible through structural typing.

### 12. Runtime options

- Status: Done
- Problem: database name, collection naming, and default TTL are hardcoded.
- Improvement: support constructor options for MongoDB database/collection naming, Redis key prefixing, automatic backend detection, and `defaultTtlSeconds`.
- Acceptance criteria:
  - Existing constructor usage remains valid.
  - Advanced users can isolate databases/collections per environment.
  - Normal users do not need to pass a backend option when the injected client shape is unambiguous.

### 13. Renewal API

- Status: Done
- Problem: long-running critical sections cannot extend ownership safely.
- Improvement: add an ownership-token-protected `extend` operation.
- Acceptance criteria:
  - Only the current owner can extend a lock.
  - Expired locks cannot be extended by stale holders.

### 14. Documentation updates

- Status: Done
- Problem: README explains the current limitation but should match the improved ownership and takeover behavior.
- Improvement: document handle-based acquisition, safe release, legacy methods, TTL caveats, and MongoDB/Redis requirements.
- Acceptance criteria:
  - Examples use the safest API by default.
  - Operational caveats are explicit.

### 15. Timed retry acquisition

- Status: Done
- Problem: callers that can wait briefly for a busy lock must implement their own polling loop around `acquire()`.
- Improvement: add `acquireWithRetry()` and `runWithRetry()` with bounded timeout and retry-delay options.
- Acceptance criteria:
  - Existing immediate-attempt APIs keep their current behavior.
  - Waiting callers receive a lock when it becomes available before the timeout.
  - Waiting callers receive `null` when the timeout elapses.
  - Callback-based retry usage releases the lock in a `finally` block.

### 16. Docker-backed integration test command

- Status: Done
- Problem: developers must manually coordinate MongoDB/Redis startup before running integration tests.
- Improvement: add a package script that starts Docker Compose services, waits for healthchecks, runs integration tests, and tears services down.
- Acceptance criteria:
  - A single command can run the full integration suite against real MongoDB and Redis.
  - Services are stopped when the command exits.
  - Manual Docker Compose instructions remain available for debugging.

## P3 - Store Adapter Expansion

### 17. Additional store adapter roadmap

- Status: Planned
- Problem: applications that already depend on stores other than MongoDB or Redis cannot use `dmutex` without introducing a new infrastructure dependency.
- Improvement: expand backend support in the following order:
  1. PostgreSQL
  2. DynamoDB
  3. MySQL
  4. Cloudflare D1
  5. Firestore
- Acceptance criteria:
  - Each adapter preserves the existing token-protected acquire, release, and extend semantics.
  - Each adapter supports bounded TTL behavior and expired-lock takeover without relying solely on asynchronous cleanup.
  - Each adapter uses a small structural client contract instead of adding mandatory runtime or peer dependencies.
  - Each adapter includes unit tests and real-backend integration coverage where practical.
