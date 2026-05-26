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
- Problem: tests require MongoDB but fail by timeout when MongoDB is unavailable.
- Improvement: either document a Docker/Testcontainers path or fail fast with a clear MongoDB connection error.
- Acceptance criteria:
  - Missing MongoDB produces an actionable failure.
  - CI can run tests repeatably.

## P2 - API Ergonomics and Operations

### 8. Driver-independent client contract

- Status: Done
- Problem: using `mongodb` package types and peer dependencies makes the library appear locked to a specific driver version.
- Improvement: use a small structural client interface and keep the official MongoDB driver only as a development/test dependency.
- Acceptance criteria:
  - Runtime package has no `mongodb` dependency or peer dependency.
  - Public declarations do not import types from `mongodb`.
  - Official `mongodb` clients remain compatible through structural typing.

### 9. Runtime options

- Status: Done
- Problem: database name, collection naming, and default TTL are hardcoded.
- Improvement: support constructor options for `dbName`, collection naming, and `defaultTtlSeconds`.
- Acceptance criteria:
  - Existing constructor usage remains valid.
  - Advanced users can isolate databases/collections per environment.

### 10. Renewal API

- Status: Done
- Problem: long-running critical sections cannot extend ownership safely.
- Improvement: add an ownership-token-protected `extend` operation.
- Acceptance criteria:
  - Only the current owner can extend a lock.
  - Expired locks cannot be extended by stale holders.

### 11. Documentation updates

- Status: Done
- Problem: README explains the current limitation but should match the improved ownership and takeover behavior.
- Improvement: document handle-based acquisition, safe release, legacy methods, TTL caveats, and MongoDB requirements.
- Acceptance criteria:
  - Examples use the safest API by default.
  - Operational caveats are explicit.
