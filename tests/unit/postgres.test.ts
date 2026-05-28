import { describe, expect, test } from "bun:test";
import {
  DMutex,
  DSemaphore,
  type DmutexPostgresClient,
  type DmutexPostgresQueryResult,
} from "../../src";

type PostgresRow = {
  key: string
  value: string
  expired_at: Date
}

class FakePostgresClient implements DmutexPostgresClient {
  public rows = new Map<string, PostgresRow>()

  public query = async <Row = Record<string, unknown>>(
    text: string,
    values: unknown[] = [],
  ): Promise<DmutexPostgresQueryResult<Row>> => {
    const statement = text.trim().toUpperCase();

    if (statement.startsWith("CREATE TABLE") || statement.startsWith("CREATE INDEX")) {
      return this.result<Row>([], null);
    }

    if (statement.startsWith("INSERT INTO")) {
      return this.acquire<Row>(values);
    }

    if (statement.startsWith("DELETE FROM")) {
      return this.release<Row>(values);
    }

    if (statement.startsWith("UPDATE")) {
      return this.extend<Row>(values);
    }

    throw new Error(`Unsupported PostgreSQL query: ${text}`);
  }

  private acquire = <Row>(values: unknown[]) => {
    const [key, token, ttlSeconds] = this.values(values);
    const now = Date.now();
    const expiredAt = new Date(now + ttlSeconds * 1000);
    const existing = this.rows.get(key);

    if (existing && existing.expired_at.getTime() > now) {
      return this.result<Row>([], 0);
    }

    this.rows.set(key, {
      key,
      value: token,
      expired_at: expiredAt,
    });

    return this.result<Row>([{ expired_at: expiredAt }], 1);
  }

  private release = <Row>(values: unknown[]) => {
    const [key, token] = this.values(values);
    const existing = this.rows.get(key);
    if (!existing || existing.value !== token) {
      return this.result<Row>([], 0);
    }

    this.rows.delete(key);
    return this.result<Row>([], 1);
  }

  private extend = <Row>(values: unknown[]) => {
    const [key, token, ttlSeconds] = this.values(values);
    const existing = this.rows.get(key);
    const now = Date.now();
    if (!existing || existing.value !== token || existing.expired_at.getTime() <= now) {
      return this.result<Row>([], 0);
    }

    existing.expired_at = new Date(now + ttlSeconds * 1000);
    return this.result<Row>([{ expired_at: existing.expired_at }], 1);
  }

  private values = (values: unknown[]) => {
    const key = String(values[0]);
    const token = String(values[1]);
    const ttlSeconds = Number(values[2]);
    return [key, token, ttlSeconds] as const;
  }

  private result = <Row>(
    rows: Array<Record<string, unknown>>,
    rowCount: number | null,
  ): DmutexPostgresQueryResult<Row> => {
    return {
      rows: rows as Row[],
      rowCount,
    };
  }
}

const mutexSlotKey = (key: string) => `permit:0:${key}`;

describe("PostgreSQL mutex backend unit", () => {
  test("supports lock, contention, and release without a real PostgreSQL server", async () => {
    const client = new FakePostgresClient();
    const mutex = new DMutex("test-service", client);

    expect(await mutex.lock("shared-key", 30)).toBe(true);
    expect(await mutex.lock("shared-key", 30)).toBe(false);
    expect(await mutex.unlock("shared-key")).toBe(true);
    expect(await mutex.lock("shared-key", 30)).toBe(true);
  });

  test("allows atomic takeover of an expired row", async () => {
    const client = new FakePostgresClient();
    const firstMutex = new DMutex("test-service", client);
    const secondMutex = new DMutex("test-service", client);

    const firstLock = await firstMutex.acquire("expired-key", 30);
    expect(firstLock).not.toBeNull();

    client.rows.get(mutexSlotKey("expired-key"))!.expired_at = new Date(Date.now() - 1000);

    const secondLock = await secondMutex.acquire("expired-key", 30);
    expect(secondLock).not.toBeNull();
    expect(secondLock!.token).not.toBe(firstLock!.token);
    expect(await firstLock!.release()).toBe(false);
    expect(client.rows.get(mutexSlotKey("expired-key"))?.value).toBe(secondLock!.token);

    await secondLock!.release();
  });

  test("extends only an active owned lock", async () => {
    const client = new FakePostgresClient();
    const mutex = new DMutex("test-service", client);

    const lock = await mutex.acquire("extend-key", 1);
    expect(lock).not.toBeNull();
    const originalExpiredAt = lock!.expiredAt.getTime();

    expect(await mutex.extend("extend-key", "wrong-token", 60)).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(await lock!.extend(60)).toBe(true);
    expect(lock!.expiredAt.getTime()).toBeGreaterThan(originalExpiredAt);

    await lock!.release();
  });

  test("supports semaphore permits through the PostgreSQL backend", async () => {
    const client = new FakePostgresClient();
    const semaphore = new DSemaphore("test-service", client, { maxPermits: 2 });

    const firstPermit = await semaphore.acquire("shared-key", 30);
    const secondPermit = await semaphore.acquire("shared-key", 30);
    const contestedPermit = await semaphore.acquire("shared-key", 30);

    expect(firstPermit).not.toBeNull();
    expect(secondPermit).not.toBeNull();
    expect(contestedPermit).toBeNull();

    await firstPermit!.release();
    await secondPermit!.release();
  });

  test("explicit backend resolves an otherwise ambiguous client", async () => {
    const client = Object.assign(new FakePostgresClient(), {
      sendCommand: async () => "OK",
    });
    const mutex = new DMutex("test-service", client, { backend: "postgresql" });

    const lock = await mutex.acquire("explicit-backend-key", 30);
    expect(lock).not.toBeNull();
    await lock!.release();
  });
});
