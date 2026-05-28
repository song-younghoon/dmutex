import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Pool } from "pg";
import { DMutex } from "../../src/mutex";

const postgresUrl = process.env.POSTGRES_URL || "postgres://postgres:postgres@localhost:5432/postgres";
const describeIntegration = process.env.DMUTEX_INTEGRATION === "1" ? describe : describe.skip;
const mutexSlotKey = (key: string) => `permit:0:${key}`;

describeIntegration("DMutex PostgreSQL integration", () => {
  let pool: Pool | undefined;
  let mutex: DMutex;
  const tableName = `_dmutex_test_service_${process.pid}`;

  beforeAll(async () => {
    pool = new Pool({
      connectionString: postgresUrl,
      connectionTimeoutMillis: 1000,
      idleTimeoutMillis: 1000,
    });

    try {
      await pool.query("SELECT 1");
    } catch (error) {
      throw new Error(
        `PostgreSQL is required for integration tests. Start PostgreSQL or set POSTGRES_URL. Tried: ${postgresUrl}`,
        { cause: error },
      );
    }

    mutex = new DMutex("test-service", pool, {
      backend: "postgresql",
      tableName,
    });
    await mutex.ready();
  });

  afterAll(async () => {
    if (!pool) {
      return;
    }

    await pool.query(`DROP TABLE IF EXISTS "${tableName.replaceAll('"', '""')}"`).catch(() => {});
    await pool.end();
  });

  test("should acquire lock successfully", async () => {
    const result = await mutex.lock("test-key-1");
    expect(result).toBe(true);

    await mutex.unlock("test-key-1");
  });

  test("should fail to acquire lock when already locked", async () => {
    const key = "test-key-2";

    expect(await mutex.lock(key)).toBe(true);
    expect(await mutex.lock(key)).toBe(false);

    await mutex.unlock(key);
  });

  test("should set expired_at correctly", async () => {
    const key = "test-key-ttl";

    expect(await mutex.lock(key, 5)).toBe(true);

    const result = await pool!.query<{ expired_at: Date }>(
      `SELECT "expired_at" FROM "${tableName.replaceAll('"', '""')}" WHERE "key" = $1`,
      [mutexSlotKey(key)],
    );

    expect(result.rows[0]?.expired_at).toBeInstanceOf(Date);

    const diff = result.rows[0]!.expired_at.getTime() - Date.now();
    expect(diff).toBeGreaterThan(4000);
    expect(diff).toBeLessThan(6000);

    await mutex.unlock(key);
  });

  test("should handle concurrent lock attempts", async () => {
    const key = "test-key-concurrent";

    const results = await Promise.all([
      mutex.lock(key),
      mutex.lock(key),
      mutex.lock(key),
    ]);

    const successCount = results.filter((result) => result === true).length;
    expect(successCount).toBe(1);

    await mutex.unlock(key);
  });

  test("should not release a lock owned by another token", async () => {
    const key = "test-key-token";
    const firstLock = await mutex.acquire(key, 30);
    expect(firstLock).not.toBeNull();

    const releasedByWrongOwner = await mutex.unlock(key, "wrong-token");
    expect(releasedByWrongOwner).toBe(false);

    const secondLockAttempt = await mutex.acquire(key, 30);
    expect(secondLockAttempt).toBeNull();

    await firstLock!.release();
  });

  test("should allow takeover of expired lock without cleanup", async () => {
    const key = "test-key-expired-takeover";
    const firstLock = await mutex.acquire(key, 30);
    expect(firstLock).not.toBeNull();

    await pool!.query(
      `UPDATE "${tableName.replaceAll('"', '""')}" SET "expired_at" = NOW() - INTERVAL '1 second' WHERE "key" = $1`,
      [mutexSlotKey(key)],
    );

    const secondLock = await mutex.acquire(key, 30);
    expect(secondLock).not.toBeNull();
    expect(secondLock!.token).not.toBe(firstLock!.token);

    const staleRelease = await firstLock!.release();
    expect(staleRelease).toBe(false);

    const result = await pool!.query<{ value: string }>(
      `SELECT "value" FROM "${tableName.replaceAll('"', '""')}" WHERE "key" = $1`,
      [mutexSlotKey(key)],
    );
    expect(result.rows[0]?.value).toBe(secondLock!.token);

    await secondLock!.release();
  });

  test("should extend only an active owned lock", async () => {
    const key = "test-key-extend";
    const lock = await mutex.acquire(key, 5);
    expect(lock).not.toBeNull();

    expect(await lock!.extend(30)).toBe(true);
    expect(await mutex.extend(key, "wrong-token", 30)).toBe(false);

    await lock!.release();
  });
});
