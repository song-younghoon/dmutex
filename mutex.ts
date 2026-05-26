import { randomUUID } from "crypto";
import { MongoMutexStore } from "./mongo-store";
import { RedisMutexStore } from "./redis-store";
import type { MutexStore } from "./store";
import type {
  DmutexMongoClient,
  DmutexRedisClient,
  MongoMutexOptions,
  MutexLock,
  MutexOptions,
  RedisMutexOptions,
} from "./types";

export type {
  BaseMutexOptions,
  DmutexMongoClient,
  DmutexMongoCollection,
  DmutexMongoCollectionDocument,
  DmutexMongoDb,
  DmutexRedisClient,
  DmutexRedisCommandClient,
  DmutexRedisMethodClient,
  MongoMutexOptions,
  MutexBackend,
  MutexLock,
  MutexOptions,
  RedisMutexOptions,
} from "./types";

export class Mutex {
  private defaultTtlSeconds: number
  private store: MutexStore
  private lockTokens = new Map<string, string>()

  constructor(serviceName: string, client: DmutexMongoClient, options?: MongoMutexOptions)
  constructor(serviceName: string, client: DmutexRedisClient, options: RedisMutexOptions)

  constructor(serviceName: string, client: DmutexMongoClient | DmutexRedisClient, options: MutexOptions = {}) {
    this.defaultTtlSeconds = options.defaultTtlSeconds ?? 5 * 60;
    this.store = options.backend === "redis"
      ? new RedisMutexStore(serviceName, client as DmutexRedisClient, options)
      : new MongoMutexStore(serviceName, client as DmutexMongoClient, options);
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

  public acquire = async (key: string, ttl?: number): Promise<MutexLock | null> => {
    const token = randomUUID();
    const expiredAt = await this.acquireWithToken(key, token, ttl);
    if (!expiredAt) {
      return null;
    }

    return {
      key,
      token,
      expiredAt,
      release: async () => await this.unlock(key, token),
      extend: async (nextTtl?: number) => await this.extend(key, token, nextTtl),
    };
  }

  public lock = async (key: string, ttl?: number) => {
    const token = randomUUID();
    const locked = await this._setnx(key, token, ttl);
    if (locked) {
      this.lockTokens.set(key, token);
    }
    return locked;
  }

  public unlock = async (key: string, token?: string) => {
    const lockToken = token ?? this.lockTokens.get(key);
    if (!lockToken) {
      return false;
    }

    const released = await this.store.release(key, lockToken);
    if (released && this.lockTokens.get(key) === lockToken) {
      this.lockTokens.delete(key);
    }

    return released;
  }

  public extend = async (key: string, token: string, ttl?: number) => {
    const ttlSeconds = this.getTtlSeconds(ttl);
    return await this.store.extend(key, token, ttlSeconds);
  }
}
