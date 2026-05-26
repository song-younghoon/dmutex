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

export type DmutexRedisCommandClient = {
  sendCommand(args: string[]): Promise<unknown> | unknown
}

export type DmutexRedisMethodClient = {
  set(...args: any[]): Promise<unknown> | unknown
  eval(...args: any[]): Promise<unknown> | unknown
}

export type DmutexRedisClient = DmutexRedisCommandClient | DmutexRedisMethodClient

export type MutexBackend = "mongodb" | "redis"

export type BaseMutexOptions = {
  defaultTtlSeconds?: number
}

export type MongoMutexOptions = BaseMutexOptions & {
  backend?: "mongodb"
  dbName?: string
  collectionName?: string
  collectionPrefix?: string
}

export type RedisMutexOptions = BaseMutexOptions & {
  backend: "redis"
  keyPrefix?: string
}

export type MutexOptions = MongoMutexOptions | RedisMutexOptions

export type MutexLock = {
  key: string
  token: string
  expiredAt: Date
  release: () => Promise<boolean>
  extend: (ttl?: number) => Promise<boolean>
}
