import { test, expect, describe } from "bun:test";
import { DMutex } from "./mutex";

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

describe("Redis mutex backend", () => {
  test("should support the legacy boolean lock interface", async () => {
    const redisClient = new FakeRedisClient();
    const mutex = new DMutex("test-service", redisClient);

    const locked = await mutex.lock("legacy-key", 30);
    expect(locked).toBe(true);

    const contested = await mutex.lock("legacy-key", 30);
    expect(contested).toBe(false);

    const unlocked = await mutex.unlock("legacy-key");
    expect(unlocked).toBe(true);

    const lockedAgain = await mutex.lock("legacy-key", 30);
    expect(lockedAgain).toBe(true);
    await mutex.unlock("legacy-key");
  });

  test("should acquire, reject contention, extend, and release with ownership token", async () => {
    const redisClient = new FakeRedisClient();
    const mutex = new DMutex("test-service", redisClient);

    const firstLock = await mutex.acquire("test-key", 30);
    expect(firstLock).not.toBeNull();

    const secondLock = await mutex.acquire("test-key", 30);
    expect(secondLock).toBeNull();

    const invalidOwnerReleased = await mutex.unlock("test-key", "wrong-token");
    expect(invalidOwnerReleased).toBe(false);

    const extended = await firstLock!.extend(60);
    expect(extended).toBe(true);

    const released = await firstLock!.release();
    expect(released).toBe(true);

    const nextLock = await mutex.acquire("test-key", 30);
    expect(nextLock).not.toBeNull();
    await nextLock!.release();
  });

  test("should namespace Redis keys by service", async () => {
    const redisClient = new FakeRedisClient();
    const firstMutex = new DMutex("first-service", redisClient);
    const secondMutex = new DMutex("second-service", redisClient);

    const firstLock = await firstMutex.acquire("shared-key", 30);
    const secondLock = await secondMutex.acquire("shared-key", 30);

    expect(firstLock).not.toBeNull();
    expect(secondLock).not.toBeNull();
    expect(redisClient.entries.has("_dmutex_first-service:shared-key")).toBe(true);
    expect(redisClient.entries.has("_dmutex_second-service:shared-key")).toBe(true);

    await firstLock!.release();
    await secondLock!.release();
  });

  test("should reject invalid ttl values before sending Redis commands", async () => {
    const redisClient = new FakeRedisClient();
    const mutex = new DMutex("test-service", redisClient);

    await expect(mutex.lock("invalid-ttl", 0)).rejects.toThrow(RangeError);
    await expect(mutex.acquire("invalid-ttl", -1)).rejects.toThrow(RangeError);
  });

  test("should reject clients that do not match a supported backend contract", () => {
    expect(() => new DMutex("test-service", {} as any)).toThrow("Cannot detect dmutex backend");
  });

  test("should reject clients that match multiple backend contracts", () => {
    const ambiguousClient = {
      db: () => ({ collection: () => ({}) }),
      sendCommand: async () => "OK",
    };

    expect(() => new DMutex("test-service", ambiguousClient as any)).toThrow(
      "matches both MongoDB and Redis contracts",
    );
  });
});
