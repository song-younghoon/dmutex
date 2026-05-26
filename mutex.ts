import { randomUUID } from "crypto";

export type DmutexMongoCollectionDocument = {
  _id: string
  value: string
  expiredAt: Date
}

export type DmutexMongoClient = {
  db(name?: string): DmutexMongoDb
}

export type DmutexMongoDb = {
  collection(name: string): DmutexMongoCollection
}

export type DmutexMongoCollection = {
  createIndex(keys: Record<string, 1 | -1>, options: { expireAfterSeconds: number }): Promise<string>
  insertOne(document: DmutexMongoCollectionDocument): Promise<unknown>
  updateOne(
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
  ): Promise<{ matchedCount?: number }>
  deleteOne(filter: Record<string, unknown>): Promise<{ deletedCount?: number }>
}

export type MutexOptions = {
  dbName?: string
  collectionName?: string
  collectionPrefix?: string
  defaultTtlSeconds?: number
}

export type MutexLock = {
  key: string
  token: string
  expiredAt: Date
  release: () => Promise<boolean>
  extend: (ttl?: number) => Promise<boolean>
}

export class Mutex {
  private serviceName: string
  private mongoClient: DmutexMongoClient
  private defaultTtlSeconds: number

  private mongoClientDb: DmutexMongoDb
  private mongoClientCollection: DmutexMongoCollection
  private indexReady: Promise<string>
  private lockTokens = new Map<string, string>()

  constructor(serviceName: string, mongoClient: DmutexMongoClient, options?: MutexOptions)

  constructor(serviceName: string, mongoClient: DmutexMongoClient, options: MutexOptions = {}) {
    this.serviceName = serviceName;
    this.mongoClient = mongoClient;
    this.defaultTtlSeconds = options.defaultTtlSeconds ?? 5 * 60;

    this.mongoClientDb = this.mongoClient.db(options.dbName ?? 'dmutex')
    this.mongoClientCollection = this.mongoClientDb.collection(
      options.collectionName ?? `${options.collectionPrefix ?? '_dmutex_'}${this.serviceName}`,
    );

    this.indexReady = this.mongoClientCollection.createIndex(
      { expiredAt: 1 },
      { expireAfterSeconds: 0 },
    );
  }

  public ready = async () => {
    await this.indexReady;
  }

  private getTtlSeconds = (ttl?: number) => {
    const ttlSeconds = ttl ?? this.defaultTtlSeconds;
    if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
      throw new RangeError("ttl must be a positive number of seconds");
    }
    return ttlSeconds;
  }

  private isDuplicateKeyError = (error: unknown) => {
    return (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: unknown }).code === 11000
    );
  }

  private acquireWithToken = async (key: string, token: string, ttl?: number) => {
    await this.ready();

    const ttlSeconds = this.getTtlSeconds(ttl);
    const now = new Date();
    const expiredAt = new Date(now.getTime() + (ttlSeconds * 1000));

    try {
      await this.mongoClientCollection.insertOne({
        _id: key,
        value: token,
        expiredAt,
      });
      return expiredAt;
    } catch (error) {
      if (!this.isDuplicateKeyError(error)) {
        throw error;
      }
    }

    const replaced = await this.mongoClientCollection.updateOne(
      { _id: key, expiredAt: { $lte: now } },
      { $set: { value: token, expiredAt } },
    );

    return replaced.matchedCount === 1 ? expiredAt : null;
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
    await this.ready();

    const lockToken = token ?? this.lockTokens.get(key);
    if (!lockToken) {
      return false;
    }

    const result = await this.mongoClientCollection.deleteOne({ _id: key, value: lockToken });
    if (result.deletedCount === 1 && this.lockTokens.get(key) === lockToken) {
      this.lockTokens.delete(key);
    }

    return result.deletedCount === 1;
  }

  public extend = async (key: string, token: string, ttl?: number) => {
    await this.ready();

    const ttlSeconds = this.getTtlSeconds(ttl);
    const now = new Date();
    const expiredAt = new Date(now.getTime() + (ttlSeconds * 1000));

    const result = await this.mongoClientCollection.updateOne(
      { _id: key, value: token, expiredAt: { $gt: now } },
      { $set: { expiredAt } },
    );

    return result.matchedCount === 1;
  }
}
