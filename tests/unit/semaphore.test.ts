import { describe, expect, test } from "bun:test";
import {
  DSemaphore,
  type DmutexMongoCollection,
  type DmutexMongoCollectionDocument,
} from "../../src";

type RedisEntry = {
  value: string
  expiresAt: number
}

class FakeRedisClient {
  public entries = new Map<string, RedisEntry>()

  public sendCommand = async (args: string[]) => {
    const command = args[0]?.toUpperCase();

    if (command === "SET") {
      const [, key, value, px, ttlMs, nx] = args;
      if (!key || !value || px !== "PX" || !ttlMs || nx !== "NX") {
        throw new Error(`Unsupported SET command: ${args.join(" ")}`);
      }

      this.deleteIfExpired(key);
      if (this.entries.has(key)) {
        return null;
      }

      this.entries.set(key, {
        value,
        expiresAt: Date.now() + Number(ttlMs),
      });

      return "OK";
    }

    if (command === "EVAL") {
      return this.evalCommand(args);
    }

    throw new Error(`Unsupported Redis command: ${command}`);
  }

  private evalCommand = (args: string[]) => {
    const [, script, keyCount, key, token, ttlMs] = args;
    if (keyCount !== "1" || !key || !token) {
      throw new Error(`Unsupported EVAL command: ${args.join(" ")}`);
    }

    this.deleteIfExpired(key);
    const entry = this.entries.get(key);
    if (!entry || entry.value !== token) {
      return 0;
    }

    if (script?.includes("PEXPIRE")) {
      if (!ttlMs) {
        throw new Error("PEXPIRE script requires ttl");
      }

      entry.expiresAt = Date.now() + Number(ttlMs);
      return 1;
    }

    if (script?.includes("DEL")) {
      this.entries.delete(key);
      return 1;
    }

    throw new Error("Unsupported EVAL script");
  }

  private deleteIfExpired = (key: string) => {
    const entry = this.entries.get(key);
    if (entry && entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
    }
  }
}

class FakeMongoCollection implements DmutexMongoCollection {
  public documents = new Map<string, DmutexMongoCollectionDocument>()

  public createIndex = async () => "expiredAt_1"

  public insertOne = async (document: DmutexMongoCollectionDocument) => {
    if (this.documents.has(document._id)) {
      throw Object.assign(new Error("duplicate key"), { code: 11000 });
    }

    this.documents.set(document._id, {
      ...document,
      expiredAt: new Date(document.expiredAt),
    });
  }

  public updateOne = async (
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
  ) => {
    const key = String(filter._id);
    const document = this.documents.get(key);
    if (!document || !this.matches(document, filter)) {
      return { matchedCount: 0 };
    }

    const nextValues = update.$set as Partial<DmutexMongoCollectionDocument> | undefined;
    if (nextValues?.value) {
      document.value = nextValues.value;
    }
    if (nextValues?.expiredAt) {
      document.expiredAt = new Date(nextValues.expiredAt);
    }

    return { matchedCount: 1 };
  }

  public deleteOne = async (filter: Record<string, unknown>) => {
    const key = String(filter._id);
    const document = this.documents.get(key);
    if (!document || !this.matches(document, filter)) {
      return { deletedCount: 0 };
    }

    this.documents.delete(key);
    return { deletedCount: 1 };
  }

  private matches = (
    document: DmutexMongoCollectionDocument,
    filter: Record<string, unknown>,
  ) => {
    if ("value" in filter && filter.value !== document.value) {
      return false;
    }

    const expiredAtFilter = filter.expiredAt;
    if (isDateComparison(expiredAtFilter, "$lte")) {
      return document.expiredAt.getTime() <= expiredAtFilter.$lte.getTime();
    }
    if (isDateComparison(expiredAtFilter, "$gt")) {
      return document.expiredAt.getTime() > expiredAtFilter.$gt.getTime();
    }

    return true;
  }
}

class FakeMongoClient {
  public collection = new FakeMongoCollection()

  public db = () => ({
    collection: () => this.collection,
  })
}

const isDateComparison = <T extends "$lte" | "$gt">(
  value: unknown,
  operator: T,
): value is Record<T, Date> => {
  return (
    typeof value === "object" &&
    value !== null &&
    operator in value &&
    (value as Record<T, unknown>)[operator] instanceof Date
  );
}

describe("DSemaphore", () => {
  test("allows up to maxPermits concurrent permits", async () => {
    const redisClient = new FakeRedisClient();
    const semaphore = new DSemaphore("test-service", redisClient, { maxPermits: 2 });

    const firstPermit = await semaphore.acquire("shared-key", 30);
    const secondPermit = await semaphore.acquire("shared-key", 30);
    const contestedPermit = await semaphore.acquire("shared-key", 30);

    expect(firstPermit).not.toBeNull();
    expect(secondPermit).not.toBeNull();
    expect(contestedPermit).toBeNull();
    expect(firstPermit!.key).toBe("shared-key");
    expect(secondPermit!.key).toBe("shared-key");
    expect(firstPermit!.slot).not.toBe(secondPermit!.slot);

    await firstPermit!.release();
    const nextPermit = await semaphore.acquire("shared-key", 30);
    expect(nextPermit).not.toBeNull();

    await secondPermit!.release();
    await nextPermit!.release();
  });

  test("protects release and extension with the permit token", async () => {
    const redisClient = new FakeRedisClient();
    const semaphore = new DSemaphore("test-service", redisClient, { maxPermits: 2 });

    const permit = await semaphore.acquire("owned-key", 1);
    expect(permit).not.toBeNull();
    const originalExpiredAt = permit!.expiredAt.getTime();

    expect(await semaphore.release("owned-key", "wrong-token")).toBe(false);
    expect(await semaphore.extend("owned-key", "wrong-token", 60)).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(await semaphore.extend("owned-key", permit!.token, 60)).toBe(true);
    expect(await permit!.extend(60)).toBe(true);
    expect(permit!.expiredAt.getTime()).toBeGreaterThan(originalExpiredAt);

    expect(await semaphore.release("owned-key", permit!.token)).toBe(true);
    expect(await semaphore.release("owned-key", permit!.token)).toBe(false);
  });

  test("runs a callback while holding one permit and releases afterward", async () => {
    const redisClient = new FakeRedisClient();
    const semaphore = new DSemaphore("test-service", redisClient, { maxPermits: 1 });

    const result = await semaphore.run("run-key", async (permit) => {
      expect(permit.key).toBe("run-key");
      expect(await semaphore.acquire("run-key", 30)).toBeNull();
      return "completed";
    }, 30);

    expect(result).toBe("completed");
    expect(await semaphore.acquire("run-key", 30)).not.toBeNull();
  });

  test("acquires with retry after a permit is released", async () => {
    const redisClient = new FakeRedisClient();
    const semaphore = new DSemaphore("test-service", redisClient, { maxPermits: 1 });

    const heldPermit = await semaphore.acquire("retry-key", 30);
    expect(heldPermit).not.toBeNull();

    const releaseLater = (async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      await heldPermit!.release();
    })();

    const nextPermit = await semaphore.acquireWithRetry("retry-key", {
      timeoutMs: 100,
      retryDelayMs: 5,
    });

    await releaseLater;
    expect(nextPermit).not.toBeNull();
    await nextPermit!.release();
  });

  test("uses a semaphore-specific Redis namespace by default", async () => {
    const redisClient = new FakeRedisClient();
    const semaphore = new DSemaphore("test-service", redisClient, { maxPermits: 1 });

    const permit = await semaphore.acquire("namespace-key", 30);
    expect(permit).not.toBeNull();
    expect(redisClient.entries.has("_dsemaphore_test-service:permit:0:namespace-key")).toBe(true);

    await permit!.release();
  });

  test("supports MongoDB expired permit takeover", async () => {
    const mongoClient = new FakeMongoClient();
    const semaphore = new DSemaphore("test-service", mongoClient, { maxPermits: 1 });

    const firstPermit = await semaphore.acquire("expired-key", 30);
    expect(firstPermit).not.toBeNull();

    const document = Array.from(mongoClient.collection.documents.values())[0];
    expect(document).toBeDefined();
    document!.expiredAt = new Date(Date.now() - 1000);

    const secondPermit = await semaphore.acquire("expired-key", 30);
    expect(secondPermit).not.toBeNull();
    expect(secondPermit!.token).not.toBe(firstPermit!.token);
    expect(await firstPermit!.release()).toBe(false);

    await secondPermit!.release();
  });

  test("rejects invalid options before sending backend commands", async () => {
    const redisClient = new FakeRedisClient();

    expect(() => new DSemaphore("test-service", redisClient, { maxPermits: 0 })).toThrow(RangeError);

    const semaphore = new DSemaphore("test-service", redisClient, { maxPermits: 1 });
    await expect(semaphore.acquire("invalid-ttl", 0)).rejects.toThrow(RangeError);
    await expect(semaphore.acquireWithRetry("invalid-wait", { timeoutMs: -1 })).rejects.toThrow(RangeError);
    await expect(semaphore.acquireWithRetry("invalid-wait", { retryDelayMs: 0 })).rejects.toThrow(RangeError);
  });
});
