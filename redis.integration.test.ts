import { afterEach, describe, expect, test } from "bun:test";
import Redis from "ioredis";
import { createClient, type RedisClientType } from "redis";
import { Mutex } from "./mutex";

const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";
const clients: Array<{ close: () => Promise<unknown> }> = [];

const makePrefix = (name: string) => `_dmutex_${name}_${process.pid}_${Date.now()}:`;

const requireRedis = async <T>(connect: () => Promise<T>) => {
  try {
    return await connect();
  } catch (error) {
    throw new Error(
      `Redis is required for integration tests. Start Redis or set REDIS_URL. Tried: ${redisUrl}`,
      { cause: error },
    );
  }
}

const exerciseMutex = async (mutex: Mutex, key: string) => {
  const firstLock = await mutex.acquire(key, 30);
  expect(firstLock).not.toBeNull();

  const contestedLock = await mutex.acquire(key, 30);
  expect(contestedLock).toBeNull();

  const wrongOwnerReleased = await mutex.unlock(key, "wrong-token");
  expect(wrongOwnerReleased).toBe(false);

  const extended = await firstLock!.extend(60);
  expect(extended).toBe(true);

  const released = await firstLock!.release();
  expect(released).toBe(true);

  const secondLock = await mutex.acquire(key, 30);
  expect(secondLock).not.toBeNull();
  await secondLock!.release();
}

afterEach(async () => {
  while (clients.length > 0) {
    const client = clients.pop();
    await client?.close().catch(() => {});
  }
});

describe("Redis client integrations", () => {
  test("supports redis createClient", async () => {
    const client = await requireRedis(async () => {
      const redisClient = createClient({
        url: redisUrl,
        socket: {
          connectTimeout: 1000,
          reconnectStrategy: false,
        },
      });
      await redisClient.connect();
      return redisClient as RedisClientType;
    });
    clients.push({ close: async () => await client.quit() });

    const mutex = new Mutex("test-service", client, {
      backend: "redis",
      keyPrefix: makePrefix("node_redis"),
    });

    await exerciseMutex(mutex, "shared-key");
  });

  test("supports ioredis", async () => {
    const client = await requireRedis(async () => {
      const redisClient = new Redis(redisUrl, {
        lazyConnect: true,
        connectTimeout: 1000,
        maxRetriesPerRequest: 0,
        retryStrategy: () => null,
      });
      await redisClient.connect();
      return redisClient;
    });
    clients.push({ close: async () => await client.quit() });

    const mutex = new Mutex("test-service", client, {
      backend: "redis",
      keyPrefix: makePrefix("ioredis"),
    });

    await exerciseMutex(mutex, "shared-key");
  });
});
