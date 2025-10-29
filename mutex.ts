import type { Db as MongoClientDb, MongoClient, Collection as MongoClientCollection } from "mongodb";

export type DmutexMongoCollectionDocument = {
  _id: string
  value: string
  expiredAt: Date
}

export class Mutex {
  private serviceName: string
  private mongoClient: MongoClient

  private mongoClientDb: MongoClientDb
  private mongoClientCollection: MongoClientCollection<DmutexMongoCollectionDocument>

  constructor(serviceName: string, mongoClient: MongoClient)

  constructor(serviceName: string, mongoClient: MongoClient) {
    this.serviceName = serviceName;
    this.mongoClient = mongoClient;

    this.mongoClientDb = this.mongoClient.db('dmutex')
    this.mongoClientCollection = this.mongoClientDb.collection(`_dmutex_${this.serviceName}`);

    this.mongoClientCollection.createIndex(
      { expiredAt: 1 },
      { expireAfterSeconds: 0 },
    );
  }

  private _setnx = async (key: string, value: string, ttl: number = 5 * 60) => {
    const expiredAt = new Date(Date.now() + (ttl * 1000));
    try {
      await this.mongoClientCollection.insertOne({
        _id: key,
        value,
        expiredAt,
      });
      return true;
    } catch {
      return false;
    }
  }

  public lock = async (key: string, ttl?: number) => {
    return await this._setnx(key, '1', ttl);
  }

  public unlock = async (key: string) => {
    await this.mongoClientCollection.deleteOne({ _id: key });
  }
}
