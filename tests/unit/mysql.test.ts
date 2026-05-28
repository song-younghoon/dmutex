import { describe, expect, test } from "bun:test";
import {
  DMutex,
  DSemaphore,
  type DmutexMySQLClient,
  type DmutexMySQLResult,
} from "../../src";

type MySQLRow = {
  key: string
  value: string
  expiredAt: number
}

class FakeMySQLClient implements DmutexMySQLClient {
  public rows = new Map<string, MySQLRow>()

  public execute = async <Result = DmutexMySQLResult>(
    sql: string,
    values: unknown[] = [],
  ): Promise<[Result, unknown]> => {
    const statement = sql.trim().toUpperCase();

    if (statement.startsWith("CREATE TABLE")) {
      return this.result<Result>({ affectedRows: 0 });
    }

    if (statement.startsWith("INSERT INTO")) {
      return this.acquire<Result>(values);
    }

    if (statement.startsWith("SELECT")) {
      return this.select<Result>(values);
    }

    if (statement.startsWith("DELETE FROM")) {
      return this.release<Result>(values);
    }

    if (statement.startsWith("UPDATE")) {
      return this.extend<Result>(values);
    }

    throw new Error(`Unsupported MySQL query: ${sql}`);
  }

  private acquire = <Result>(values: unknown[]) => {
    const [key, token, expiredAt, now] = this.values(values);
    const existing = this.rows.get(key);

    if (existing && existing.expiredAt > now) {
      return this.result<Result>({ affectedRows: 0 });
    }

    this.rows.set(key, {
      key,
      value: token,
      expiredAt,
    });

    return this.result<Result>({ affectedRows: existing ? 2 : 1 });
  }

  private release = <Result>(values: unknown[]) => {
    const key = String(values[0]);
    const token = String(values[1]);
    const existing = this.rows.get(key);

    if (!existing || existing.value !== token) {
      return this.result<Result>({ affectedRows: 0 });
    }

    this.rows.delete(key);
    return this.result<Result>({ affectedRows: 1 });
  }

  private select = <Result>(values: unknown[]) => {
    const key = String(values[0]);
    const existing = this.rows.get(key);
    const rows = existing
      ? [{ value: existing.value, expired_at: existing.expiredAt }]
      : [];

    return [rows as Result, []] as [Result, unknown];
  }

  private extend = <Result>(values: unknown[]) => {
    const expiredAt = Number(values[0]);
    const key = String(values[1]);
    const token = String(values[2]);
    const now = Number(values[3]);
    const existing = this.rows.get(key);

    if (!existing || existing.value !== token || existing.expiredAt <= now) {
      return this.result<Result>({ affectedRows: 0 });
    }

    existing.expiredAt = expiredAt;
    return this.result<Result>({ affectedRows: 1 });
  }

  private values = (values: unknown[]) => {
    const key = String(values[0]);
    const token = String(values[1]);
    const expiredAt = Number(values[2]);
    const now = Number(values[3]);
    return [key, token, expiredAt, now] as const;
  }

  private result = <Result>(result: DmutexMySQLResult): [Result, unknown] => {
    return [result as Result, []];
  }
}

const mutexSlotKey = (key: string) => `permit:0:${key}`;

describe("MySQL mutex backend unit", () => {
  test("supports lock, contention, and release without a real MySQL server", async () => {
    const client = new FakeMySQLClient();
    const mutex = new DMutex("test-service", client);

    expect(await mutex.lock("shared-key", 30)).toBe(true);
    expect(await mutex.lock("shared-key", 30)).toBe(false);
    expect(await mutex.unlock("shared-key")).toBe(true);
    expect(await mutex.lock("shared-key", 30)).toBe(true);
  });

  test("allows atomic takeover of an expired row", async () => {
    const client = new FakeMySQLClient();
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
    const client = new FakeMySQLClient();
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

  test("supports semaphore permits through the MySQL backend", async () => {
    const client = new FakeMySQLClient();
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

  test("explicit backend resolves an otherwise ambiguous query client", async () => {
    const client = Object.assign(new FakeMySQLClient(), {
      query: async () => [[], []],
    });
    const mutex = new DMutex("test-service", client, { backend: "mysql" });

    const lock = await mutex.acquire("explicit-backend-key", 30);
    expect(lock).not.toBeNull();
    await lock!.release();
  });
});
