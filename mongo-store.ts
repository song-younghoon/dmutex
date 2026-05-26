import type {
  DmutexMongoClient,
  DmutexMongoCollection,
  MongoDMutexOptions,
} from "./types";
import type { DMutexStore } from "./store";

const isDuplicateKeyError = (error: unknown) => {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === 11000
  );
}

export class MongoDMutexStore implements DMutexStore {
  private collection: DmutexMongoCollection
  private indexReady: Promise<string>

  constructor(serviceName: string, mongoClient: DmutexMongoClient, options: MongoDMutexOptions) {
    const db = mongoClient.db(options.dbName ?? 'dmutex');
    this.collection = db.collection(
      options.collectionName ?? `${options.collectionPrefix ?? '_dmutex_'}${serviceName}`,
    );

    this.indexReady = this.collection.createIndex(
      { expiredAt: 1 },
      { expireAfterSeconds: 0 },
    );
  }

  public ready = async () => {
    await this.indexReady;
  }

  public acquire = async (key: string, token: string, ttlSeconds: number) => {
    await this.ready();

    const now = new Date();
    const expiredAt = new Date(now.getTime() + (ttlSeconds * 1000));

    try {
      await this.collection.insertOne({
        _id: key,
        value: token,
        expiredAt,
      });
      return expiredAt;
    } catch (error) {
      if (!isDuplicateKeyError(error)) {
        throw error;
      }
    }

    const replaced = await this.collection.updateOne(
      { _id: key, expiredAt: { $lte: now } },
      { $set: { value: token, expiredAt } },
    );

    return replaced.matchedCount === 1 ? expiredAt : null;
  }

  public release = async (key: string, token: string) => {
    await this.ready();

    const result = await this.collection.deleteOne({ _id: key, value: token });
    return result.deletedCount === 1;
  }

  public extend = async (key: string, token: string, ttlSeconds: number) => {
    await this.ready();

    const now = new Date();
    const expiredAt = new Date(now.getTime() + (ttlSeconds * 1000));

    const result = await this.collection.updateOne(
      { _id: key, value: token, expiredAt: { $gt: now } },
      { $set: { expiredAt } },
    );

    return result.matchedCount === 1;
  }
}
