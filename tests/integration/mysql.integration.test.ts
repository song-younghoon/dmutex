import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import mysql, { type Pool } from "mysql2/promise";
import { DMutex } from "../../src/mutex";

const mysqlUrl = process.env.MYSQL_URL || "mysql://root:mysql@localhost:3306/dmutex";
const describeIntegration = process.env.DMUTEX_INTEGRATION === "1" ? describe : describe.skip;
const mutexSlotKey = (key: string) => `permit:0:${key}`;

const quoteIdentifier = (identifier: string) => `\`${identifier.replaceAll("`", "``")}\``;

describeIntegration("DMutex MySQL integration", () => {
  let pool: Pool | undefined;
  let mutex: DMutex;
  const tableName = `_dmutex_test_service_${process.pid}`;

  beforeAll(async () => {
    pool = mysql.createPool({
      uri: mysqlUrl,
      connectTimeout: 1000,
      waitForConnections: true,
      connectionLimit: 4,
    });

    try {
      await pool.execute("SELECT 1");
    } catch (error) {
      throw new Error(
        `MySQL is required for integration tests. Start MySQL or set MYSQL_URL. Tried: ${mysqlUrl}`,
        { cause: error },
      );
    }

    mutex = new DMutex("test-service", pool, {
      backend: "mysql",
      tableName,
    });
    await mutex.ready();
  });

  afterAll(async () => {
    if (!pool) {
      return;
    }

    await pool.execute(`DROP TABLE IF EXISTS ${quoteIdentifier(tableName)}`).catch(() => {});
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

  test("should store expiration correctly", async () => {
    const key = "test-key-ttl";

    expect(await mutex.lock(key, 5)).toBe(true);

    const [rows] = await pool!.execute(
      `SELECT \`expired_at\` FROM ${quoteIdentifier(tableName)} WHERE \`key\` = ?`,
      [mutexSlotKey(key)],
    ) as [Array<{ expired_at: number | string }>, unknown];

    const expiredAt = Number(rows[0]?.expired_at);
    expect(Number.isFinite(expiredAt)).toBe(true);

    const diff = expiredAt - Date.now();
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

    await pool!.execute(
      `UPDATE ${quoteIdentifier(tableName)} SET \`expired_at\` = ? WHERE \`key\` = ?`,
      [Date.now() - 1000, mutexSlotKey(key)],
    );

    const secondLock = await mutex.acquire(key, 30);
    expect(secondLock).not.toBeNull();
    expect(secondLock!.token).not.toBe(firstLock!.token);

    const staleRelease = await firstLock!.release();
    expect(staleRelease).toBe(false);

    const [rows] = await pool!.execute(
      `SELECT \`value\` FROM ${quoteIdentifier(tableName)} WHERE \`key\` = ?`,
      [mutexSlotKey(key)],
    ) as [Array<{ value: string }>, unknown];
    expect(rows[0]?.value).toBe(secondLock!.token);

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
