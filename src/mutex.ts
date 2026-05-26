import { randomUUID } from "crypto";
import { MongoDMutexStore } from "./mongo-store";
import { RedisDMutexStore } from "./redis-store";
import type { DMutexStore } from "./store";
import type {
  DMutexBackend,
  DmutexMongoClient,
  DmutexRedisClient,
  DMutexLock,
  DMutexOptions,
  MongoDMutexOptions,
  RedisDMutexOptions,
} from "./types";

export type {
  BaseDMutexOptions,
  DMutexBackend,
  DMutexLock,
  DMutexOptions,
  DmutexMongoClient,
  DmutexMongoCollection,
  DmutexMongoCollectionDocument,
  DmutexMongoDb,
  DmutexRedisClient,
  DmutexRedisCommandClient,
  DmutexRedisMethodClient,
  MongoDMutexOptions,
  RedisDMutexOptions,
} from "./types";

const hasFunction = <T extends string>(
  value: unknown,
  name: T,
): value is Record<T, (...args: any[]) => unknown> => {
  return (
    typeof value === "object" &&
    value !== null &&
    name in value &&
    typeof (value as Record<T, unknown>)[name] === "function"
  );
}

const isMongoClient = (client: unknown): client is DmutexMongoClient => {
  return hasFunction(client, "db");
}

const isRedisClient = (client: unknown): client is DmutexRedisClient => {
  return hasFunction(client, "sendCommand") ||
    (hasFunction(client, "set") && hasFunction(client, "eval"));
}

const detectBackend = (
  client: DmutexMongoClient | DmutexRedisClient,
  explicitBackend?: DMutexBackend,
) => {
  const matchesMongo = isMongoClient(client);
  const matchesRedis = isRedisClient(client);

  if (
    explicitBackend !== undefined &&
    explicitBackend !== "mongodb" &&
    explicitBackend !== "redis"
  ) {
    throw new Error("dmutex backend must be either mongodb or redis");
  }

  if (explicitBackend === "mongodb") {
    if (!matchesMongo) {
      throw new Error(
        "Cannot use MongoDB backend; client must provide MongoDB db()",
      );
    }
    return "mongodb";
  }

  if (explicitBackend === "redis") {
    if (!matchesRedis) {
      throw new Error(
        "Cannot use Redis backend; client must provide Redis sendCommand(args) or set(...args) plus eval(...args)",
      );
    }
    return "redis";
  }

  if (matchesMongo && !matchesRedis) {
    return "mongodb";
  }

  if (matchesRedis && !matchesMongo) {
    return "redis";
  }

  if (matchesMongo && matchesRedis) {
    throw new Error(
      "Cannot detect dmutex backend because the client matches both MongoDB and Redis contracts",
    );
  }

  throw new Error(
    "Cannot detect dmutex backend; client must provide MongoDB db() or Redis sendCommand(args) / set(...args) plus eval(...args)",
  );
}

export class DMutex {
  private defaultTtlSeconds: number
  private store: DMutexStore
  private lockTokens = new Map<string, string>()

  constructor(serviceName: string, client: DmutexMongoClient, options?: MongoDMutexOptions)
  constructor(serviceName: string, client: DmutexRedisClient, options?: RedisDMutexOptions)

  constructor(serviceName: string, client: DmutexMongoClient | DmutexRedisClient, options: DMutexOptions = {}) {
    this.defaultTtlSeconds = options.defaultTtlSeconds ?? 5 * 60;
    const backend = detectBackend(client, options.backend);
    this.store = backend === "redis"
      ? new RedisDMutexStore(serviceName, client as DmutexRedisClient, options as RedisDMutexOptions)
      : new MongoDMutexStore(serviceName, client as DmutexMongoClient, options as MongoDMutexOptions);
  }

  public ready = async () => {
    await this.store.ready();
  }

  private getTtlSeconds = (ttl?: number) => {
    const ttlSeconds = ttl ?? this.defaultTtlSeconds;
    if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
      throw new RangeError("ttl must be a positive number of seconds");
    }
    return ttlSeconds;
  }

  private acquireWithToken = async (key: string, token: string, ttl?: number) => {
    const ttlSeconds = this.getTtlSeconds(ttl);
    return await this.store.acquire(key, token, ttlSeconds);
  }

  private _setnx = async (key: string, value: string, ttl?: number) => {
    const expiredAt = await this.acquireWithToken(key, value, ttl);
    return expiredAt !== null;
  }

  private releaseWithToken = async (key: string, token: string) => {
    return await this.store.release(key, token);
  }

  public acquire = async (key: string, ttl?: number): Promise<DMutexLock | null> => {
    const token = randomUUID();
    const expiredAt = await this.acquireWithToken(key, token, ttl);
    if (!expiredAt) {
      return null;
    }

    return {
      key,
      token,
      expiredAt,
      release: async () => await this.releaseWithToken(key, token),
      extend: async (nextTtl?: number) => await this.extend(key, token, nextTtl),
    };
  }

  /**
   * @deprecated Use acquire() instead. acquire() returns a lock handle that
   * carries its ownership token and is safer across async boundaries.
   */
  public lock = async (key: string, ttl?: number) => {
    const token = randomUUID();
    const locked = await this._setnx(key, token, ttl);
    if (locked) {
      this.lockTokens.set(key, token);
    }
    return locked;
  }

  /**
   * @deprecated Prefer lock.release() from acquire(). unlock(key) depends on
   * token state stored in this DMutex instance unless a token is provided.
   */
  public unlock = async (key: string, token?: string) => {
    const lockToken = token ?? this.lockTokens.get(key);
    if (!lockToken) {
      return false;
    }

    const released = await this.store.release(key, lockToken);
    if (this.lockTokens.get(key) === lockToken) {
      this.lockTokens.delete(key);
    }

    return released;
  }

  public extend = async (key: string, token: string, ttl?: number) => {
    const ttlSeconds = this.getTtlSeconds(ttl);
    return await this.store.extend(key, token, ttlSeconds);
  }
}
