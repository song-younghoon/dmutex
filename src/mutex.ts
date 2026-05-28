import { DSemaphore } from "./semaphore";
import type {
  DmutexDynamoDBClient,
  DmutexMongoClient,
  DmutexMySQLClient,
  DmutexRedisClient,
  DMutexLock,
  DMutexOptions,
  DMutexWaitOptions,
  DynamoDBDMutexOptions,
  DSemaphoreOptions,
  DSemaphorePermit,
  DmutexPostgresClient,
  MongoDMutexOptions,
  MySQLDMutexOptions,
  PostgresDMutexOptions,
  RedisDMutexOptions,
} from "./types";

export type {
  BaseDMutexOptions,
  DmutexDynamoDBAttributeValue,
  DmutexDynamoDBClient,
  DMutexBackend,
  DMutexLock,
  DMutexOptions,
  DMutexWaitOptions,
  DynamoDBDMutexOptions,
  DmutexMongoClient,
  DmutexMongoCollection,
  DmutexMongoCollectionDocument,
  DmutexMongoDb,
  DmutexMySQLClient,
  DmutexMySQLResult,
  DmutexPostgresClient,
  DmutexPostgresQueryResult,
  DmutexRedisClient,
  DmutexRedisCommandClient,
  DmutexRedisMethodClient,
  MongoDMutexOptions,
  MySQLDMutexOptions,
  PostgresDMutexOptions,
  RedisDMutexOptions,
} from "./types";

export class DMutex {
  private semaphore: DSemaphore
  private lockTokens = new Map<string, string>()

  constructor(serviceName: string, client: DmutexMongoClient, options?: MongoDMutexOptions)
  constructor(serviceName: string, client: DmutexRedisClient, options?: RedisDMutexOptions)
  constructor(serviceName: string, client: DmutexPostgresClient, options?: PostgresDMutexOptions)
  constructor(serviceName: string, client: DmutexDynamoDBClient, options?: DynamoDBDMutexOptions)
  constructor(serviceName: string, client: DmutexMySQLClient, options?: MySQLDMutexOptions)
  constructor(
    serviceName: string,
    client:
      | DmutexMongoClient
      | DmutexRedisClient
      | DmutexPostgresClient
      | DmutexDynamoDBClient
      | DmutexMySQLClient,
    options?: DMutexOptions,
  )

  constructor(
    serviceName: string,
    client:
      | DmutexMongoClient
      | DmutexRedisClient
      | DmutexPostgresClient
      | DmutexDynamoDBClient
      | DmutexMySQLClient,
    options: DMutexOptions = {},
  ) {
    this.semaphore = new DSemaphore(serviceName, client, this.getSemaphoreOptions(serviceName, options));
  }

  public ready = async () => {
    await this.semaphore.ready();
  }

  private getSemaphoreOptions = (serviceName: string, options: DMutexOptions): DSemaphoreOptions => {
    const semaphoreOptions = { ...options, maxPermits: 1 } as DSemaphoreOptions & {
      collectionPrefix?: string
      keyPrefix?: string
      tablePrefix?: string
    };

    semaphoreOptions.collectionPrefix ??= "_dmutex_";
    semaphoreOptions.keyPrefix ??= `_dmutex_${serviceName}:`;
    semaphoreOptions.tablePrefix ??= "_dmutex_";

    return semaphoreOptions;
  }

  private lockFromPermit = (permit: DSemaphorePermit): DMutexLock => {
    const lock: DMutexLock = {
      key: permit.key,
      token: permit.token,
      expiredAt: permit.expiredAt,
      release: async () => await permit.release(),
      extend: async (ttl?: number) => {
        const extended = await permit.extend(ttl);
        if (extended) {
          lock.expiredAt = permit.expiredAt;
        }

        return extended;
      },
    };

    return lock;
  }

  public acquire = async (key: string, ttl?: number): Promise<DMutexLock | null> => {
    const permit = await this.semaphore.acquire(key, ttl);
    return permit ? this.lockFromPermit(permit) : null;
  }

  public run = async <T>(
    key: string,
    callback: (lock: DMutexLock) => Promise<T> | T,
    ttl?: number,
  ): Promise<T | null> => {
    const lock = await this.acquire(key, ttl);
    if (!lock) {
      return null;
    }

    try {
      return await callback(lock);
    } finally {
      await lock.release();
    }
  }

  public acquireWithRetry = async (
    key: string,
    options: DMutexWaitOptions = {},
  ): Promise<DMutexLock | null> => {
    const permit = await this.semaphore.acquireWithRetry(key, options);
    return permit ? this.lockFromPermit(permit) : null;
  }

  public runWithRetry = async <T>(
    key: string,
    callback: (lock: DMutexLock) => Promise<T> | T,
    options: DMutexWaitOptions = {},
  ): Promise<T | null> => {
    const lock = await this.acquireWithRetry(key, options);
    if (!lock) {
      return null;
    }

    try {
      return await callback(lock);
    } finally {
      await lock.release();
    }
  }

  /**
   * @deprecated Use acquire() instead. acquire() returns a lock handle that
   * carries its ownership token and is safer across async boundaries.
   */
  public lock = async (key: string, ttl?: number) => {
    const lock = await this.acquire(key, ttl);
    if (!lock) {
      return false;
    }

    this.lockTokens.set(key, lock.token);
    return true;
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

    const released = await this.semaphore.release(key, lockToken);
    if (this.lockTokens.get(key) === lockToken) {
      this.lockTokens.delete(key);
    }

    return released;
  }

  public extend = async (key: string, token: string, ttl?: number) => {
    return await this.semaphore.extend(key, token, ttl);
  }
}
