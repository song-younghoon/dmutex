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

export type DmutexPostgresQueryResult<Row = Record<string, unknown>> = {
  rowCount?: number | null
  rows: Row[]
}

export type DmutexPostgresClient = {
  query<Row = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<DmutexPostgresQueryResult<Row>> | DmutexPostgresQueryResult<Row>
}

export type DMutexBackend = "mongodb" | "redis" | "postgresql"

export type BaseDMutexOptions = {
  defaultTtlSeconds?: number
  backend?: DMutexBackend
}

export type MongoDMutexOptions = BaseDMutexOptions & {
  dbName?: string
  collectionName?: string
  collectionPrefix?: string
}

export type RedisDMutexOptions = BaseDMutexOptions & {
  keyPrefix?: string
}

export type PostgresDMutexOptions = BaseDMutexOptions & {
  schemaName?: string
  tableName?: string
  tablePrefix?: string
}

export type DMutexOptions = MongoDMutexOptions | RedisDMutexOptions | PostgresDMutexOptions

export type DMutexWaitOptions = {
  ttl?: number
  timeoutMs?: number
  retryDelayMs?: number
}

export type DMutexLock = {
  key: string
  token: string
  expiredAt: Date
  release: () => Promise<boolean>
  extend: (ttl?: number) => Promise<boolean>
}

export type BaseDSemaphoreOptions = BaseDMutexOptions & {
  maxPermits: number
}

export type MongoDSemaphoreOptions = MongoDMutexOptions & BaseDSemaphoreOptions

export type RedisDSemaphoreOptions = RedisDMutexOptions & BaseDSemaphoreOptions

export type PostgresDSemaphoreOptions = PostgresDMutexOptions & BaseDSemaphoreOptions

export type DSemaphoreOptions = MongoDSemaphoreOptions | RedisDSemaphoreOptions | PostgresDSemaphoreOptions

export type DSemaphoreWaitOptions = DMutexWaitOptions

export type DSemaphorePermit = {
  key: string
  token: string
  slot: number
  expiredAt: Date
  release: () => Promise<boolean>
  extend: (ttl?: number) => Promise<boolean>
}
