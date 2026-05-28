import { describe, expect, test } from "bun:test";
import {
  DMutex,
  DSemaphore,
  type DmutexD1Database,
  type DmutexD1PreparedStatement,
  type DmutexD1Result,
} from "../../src";

type D1Row = {
  key: string
  value: string
  expiredAt: number
}

class FakeD1PreparedStatement implements DmutexD1PreparedStatement {
  private values: unknown[] = []

  constructor(
    private database: FakeD1Database,
    private sql: string,
  ) {}

  public bind = (...values: unknown[]) => {
    this.values = values;
    return this;
  }

  public run = async (): Promise<DmutexD1Result> => {
    return this.database.run(this.sql, this.values);
  }

  public first = async <Row = Record<string, unknown>>() => {
    return this.database.first<Row>(this.sql, this.values);
  }
}

class FakeD1Database implements DmutexD1Database {
  public rows = new Map<string, D1Row>()

  public prepare = (sql: string) => new FakeD1PreparedStatement(this, sql)

  public run = (sql: string, values: unknown[]): DmutexD1Result => {
    const statement = sql.trim().toUpperCase();

    if (statement.startsWith("CREATE TABLE") || statement.startsWith("CREATE INDEX")) {
      return { success: true, meta: { changes: 0 } };
    }

    if (statement.startsWith("INSERT INTO")) {
      return this.acquire(values);
    }

    if (statement.startsWith("DELETE FROM")) {
      return this.release(values);
    }

    if (statement.startsWith("UPDATE")) {
      return this.extend(values);
    }

    throw new Error(`Unsupported D1 query: ${sql}`);
  }

  public first = <Row = Record<string, unknown>>(sql: string, values: unknown[]) => {
    const statement = sql.trim().toUpperCase();
    if (!statement.startsWith("SELECT")) {
      throw new Error(`Unsupported D1 query: ${sql}`);
    }

    const existing = this.rows.get(String(values[0]));
    if (!existing) {
      return null;
    }

    return {
      value: existing.value,
      expired_at: existing.expiredAt,
    } as Row;
  }

  private acquire = (values: unknown[]) => {
    const key = String(values[0]);
    const token = String(values[1]);
    const expiredAt = Number(values[2]);
    const now = Number(values[3]);
    const existing = this.rows.get(key);

    if (existing && existing.expiredAt > now) {
      return { success: true, meta: { changes: 0 } };
    }

    this.rows.set(key, {
      key,
      value: token,
      expiredAt,
    });

    return { success: true, meta: { changes: 1 } };
  }

  private release = (values: unknown[]) => {
    const key = String(values[0]);
    const token = String(values[1]);
    const existing = this.rows.get(key);

    if (!existing || existing.value !== token) {
      return { success: true, meta: { changes: 0 } };
    }

    this.rows.delete(key);
    return { success: true, meta: { changes: 1 } };
  }

  private extend = (values: unknown[]) => {
    const expiredAt = Number(values[0]);
    const key = String(values[1]);
    const token = String(values[2]);
    const now = Number(values[3]);
    const existing = this.rows.get(key);

    if (!existing || existing.value !== token || existing.expiredAt <= now) {
      return { success: true, meta: { changes: 0 } };
    }

    existing.expiredAt = expiredAt;
    return { success: true, meta: { changes: 1 } };
  }
}

const mutexSlotKey = (key: string) => `permit:0:${key}`;

describe("Cloudflare D1 mutex backend unit", () => {
  test("supports lock, contention, and release without a real D1 database", async () => {
    const client = new FakeD1Database();
    const mutex = new DMutex("test-service", client);

    expect(await mutex.lock("shared-key", 30)).toBe(true);
    expect(await mutex.lock("shared-key", 30)).toBe(false);
    expect(await mutex.unlock("shared-key")).toBe(true);
    expect(await mutex.lock("shared-key", 30)).toBe(true);
  });

  test("allows atomic takeover of an expired row", async () => {
    const client = new FakeD1Database();
    const firstMutex = new DMutex("test-service", client);
    const secondMutex = new DMutex("test-service", client);

    const firstLock = await firstMutex.acquire("expired-key", 30);
    expect(firstLock).not.toBeNull();

    client.rows.get(mutexSlotKey("expired-key"))!.expiredAt = Date.now() - 1000;

    const secondLock = await secondMutex.acquire("expired-key", 30);
    expect(secondLock).not.toBeNull();
    expect(secondLock!.token).not.toBe(firstLock!.token);
    expect(await firstLock!.release()).toBe(false);
    expect(client.rows.get(mutexSlotKey("expired-key"))?.value).toBe(secondLock!.token);

    await secondLock!.release();
  });

  test("extends only an active owned lock", async () => {
    const client = new FakeD1Database();
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

  test("supports semaphore permits through the D1 backend", async () => {
    const client = new FakeD1Database();
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
    const client = Object.assign(new FakeD1Database(), {
      query: async () => ({ rows: [] }),
    });
    const mutex = new DMutex("test-service", client, { backend: "d1" });

    const lock = await mutex.acquire("explicit-backend-key", 30);
    expect(lock).not.toBeNull();
    await lock!.release();
  });
});
