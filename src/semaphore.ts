import { randomUUID } from "crypto";
import { createDMutexStore } from "./backend";
import type { DMutexStore } from "./store";
import type {
  D1DSemaphoreOptions,
  DmutexD1Database,
  DmutexDynamoDBClient,
  DmutexFirestoreClient,
  DmutexMongoClient,
  DmutexMySQLClient,
  DmutexPostgresClient,
  DmutexRedisClient,
  DMutexOptions,
  DynamoDBDSemaphoreOptions,
  DSemaphoreOptions,
  DSemaphorePermit,
  DSemaphoreWaitOptions,
  FirestoreDSemaphoreOptions,
  MongoDSemaphoreOptions,
  MySQLDSemaphoreOptions,
  PostgresDSemaphoreOptions,
  RedisDSemaphoreOptions,
} from "./types";

export type {
  D1DSemaphoreOptions,
  BaseDSemaphoreOptions,
  DynamoDBDSemaphoreOptions,
  DSemaphoreOptions,
  DSemaphorePermit,
  DSemaphoreWaitOptions,
  FirestoreDSemaphoreOptions,
  MongoDSemaphoreOptions,
  MySQLDSemaphoreOptions,
  PostgresDSemaphoreOptions,
  RedisDSemaphoreOptions,
} from "./types";

const DEFAULT_WAIT_TIMEOUT_MS = 30_000;
const DEFAULT_RETRY_DELAY_MS = 100;

const sleep = async (ms: number) => {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export class DSemaphore {
  private defaultTtlSeconds: number
  private maxPermits: number
  private store: DMutexStore

  constructor(serviceName: string, client: DmutexMongoClient, options: MongoDSemaphoreOptions)
  constructor(serviceName: string, client: DmutexRedisClient, options: RedisDSemaphoreOptions)
  constructor(serviceName: string, client: DmutexPostgresClient, options: PostgresDSemaphoreOptions)
  constructor(serviceName: string, client: DmutexDynamoDBClient, options: DynamoDBDSemaphoreOptions)
  constructor(serviceName: string, client: DmutexMySQLClient, options: MySQLDSemaphoreOptions)
  constructor(serviceName: string, client: DmutexD1Database, options: D1DSemaphoreOptions)
  constructor(serviceName: string, client: DmutexFirestoreClient, options: FirestoreDSemaphoreOptions)
  constructor(
    serviceName: string,
    client:
      | DmutexMongoClient
      | DmutexRedisClient
      | DmutexPostgresClient
      | DmutexDynamoDBClient
      | DmutexMySQLClient
      | DmutexD1Database
      | DmutexFirestoreClient,
    options: DSemaphoreOptions,
  )

  constructor(
    serviceName: string,
    client:
      | DmutexMongoClient
      | DmutexRedisClient
      | DmutexPostgresClient
      | DmutexDynamoDBClient
      | DmutexMySQLClient
      | DmutexD1Database
      | DmutexFirestoreClient,
    options: DSemaphoreOptions,
  ) {
    this.defaultTtlSeconds = options.defaultTtlSeconds ?? 5 * 60;
    this.maxPermits = this.getMaxPermits(options.maxPermits);
    this.store = createDMutexStore(serviceName, client, this.getStoreOptions(serviceName, options));
  }

  public ready = async () => {
    await this.store.ready();
  }

  private getMaxPermits = (maxPermits: number) => {
    if (!Number.isInteger(maxPermits) || maxPermits <= 0) {
      throw new RangeError("maxPermits must be a positive integer");
    }

    return maxPermits;
  }

  private getStoreOptions = (serviceName: string, options: DSemaphoreOptions): DMutexOptions => {
    const storeOptions = { ...options } as DMutexOptions & {
      maxPermits?: number
      collectionPrefix?: string
      keyPrefix?: string
      tablePrefix?: string
    };

    delete storeOptions.maxPermits;
    storeOptions.collectionPrefix ??= "_dsemaphore_";
    storeOptions.keyPrefix ??= `_dsemaphore_${serviceName}:`;
    storeOptions.tablePrefix ??= "_dsemaphore_";

    return storeOptions;
  }

  private getTtlSeconds = (ttl?: number) => {
    const ttlSeconds = ttl ?? this.defaultTtlSeconds;
    if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
      throw new RangeError("ttl must be a positive number of seconds");
    }

    return ttlSeconds;
  }

  private getWaitOptions = (options: DSemaphoreWaitOptions = {}) => {
    const timeoutMs = options.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
    const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;

    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
      throw new RangeError("timeoutMs must be a non-negative finite number");
    }

    if (!Number.isFinite(retryDelayMs) || retryDelayMs <= 0) {
      throw new RangeError("retryDelayMs must be a positive finite number");
    }

    return {
      ttl: options.ttl,
      timeoutMs,
      retryDelayMs,
    };
  }

  private slotKey = (key: string, slot: number) => `permit:${slot}:${key}`

  private permitFromSlot = (
    key: string,
    slot: number,
    token: string,
    expiredAt: Date,
  ): DSemaphorePermit => {
    const slotKey = this.slotKey(key, slot);
    const permit: DSemaphorePermit = {
      key,
      slot,
      token,
      expiredAt,
      release: async () => await this.store.release(slotKey, token),
      extend: async (ttl?: number) => {
        const nextExpiredAt = await this.store.extend(slotKey, token, this.getTtlSeconds(ttl));
        if (!nextExpiredAt) {
          return false;
        }

        permit.expiredAt = nextExpiredAt;
        return true;
      },
    };

    return permit;
  }

  public acquire = async (key: string, ttl?: number): Promise<DSemaphorePermit | null> => {
    const token = randomUUID();
    const ttlSeconds = this.getTtlSeconds(ttl);

    for (let slot = 0; slot < this.maxPermits; slot += 1) {
      const expiredAt = await this.store.acquire(this.slotKey(key, slot), token, ttlSeconds);
      if (expiredAt) {
        return this.permitFromSlot(key, slot, token, expiredAt);
      }
    }

    return null;
  }

  public run = async <T>(
    key: string,
    callback: (permit: DSemaphorePermit) => Promise<T> | T,
    ttl?: number,
  ): Promise<T | null> => {
    const permit = await this.acquire(key, ttl);
    if (!permit) {
      return null;
    }

    try {
      return await callback(permit);
    } finally {
      await permit.release();
    }
  }

  public acquireWithRetry = async (
    key: string,
    options: DSemaphoreWaitOptions = {},
  ): Promise<DSemaphorePermit | null> => {
    const { ttl, timeoutMs, retryDelayMs } = this.getWaitOptions(options);
    const deadline = Date.now() + timeoutMs;

    while (true) {
      const permit = await this.acquire(key, ttl);
      if (permit) {
        return permit;
      }

      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        return null;
      }

      await sleep(Math.min(retryDelayMs, remainingMs));
    }
  }

  public runWithRetry = async <T>(
    key: string,
    callback: (permit: DSemaphorePermit) => Promise<T> | T,
    options: DSemaphoreWaitOptions = {},
  ): Promise<T | null> => {
    const permit = await this.acquireWithRetry(key, options);
    if (!permit) {
      return null;
    }

    try {
      return await callback(permit);
    } finally {
      await permit.release();
    }
  }

  public release = async (key: string, token: string) => {
    for (let slot = 0; slot < this.maxPermits; slot += 1) {
      const released = await this.store.release(this.slotKey(key, slot), token);
      if (released) {
        return true;
      }
    }

    return false;
  }

  public extend = async (key: string, token: string, ttl?: number) => {
    const ttlSeconds = this.getTtlSeconds(ttl);

    for (let slot = 0; slot < this.maxPermits; slot += 1) {
      const nextExpiredAt = await this.store.extend(this.slotKey(key, slot), token, ttlSeconds);
      if (nextExpiredAt) {
        return true;
      }
    }

    return false;
  }
}
