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

export type DmutexDynamoDBAttributeValue = {
  S?: string
  N?: string
  [key: string]: unknown
}

export type DmutexDynamoDBClient = {
  createTable(input: Record<string, unknown>): Promise<unknown> | unknown
  describeTable(
    input: Record<string, unknown>,
  ): Promise<{ Table?: { TableStatus?: string } }> | { Table?: { TableStatus?: string } }
  putItem(input: Record<string, unknown>): Promise<unknown> | unknown
  deleteItem(input: Record<string, unknown>): Promise<unknown> | unknown
  updateItem(
    input: Record<string, unknown>,
  ): Promise<{ Attributes?: Record<string, DmutexDynamoDBAttributeValue> }> | { Attributes?: Record<string, DmutexDynamoDBAttributeValue> }
}

export type DmutexMySQLResult = {
  affectedRows?: number
}

export type DmutexMySQLClient = {
  execute<Result = DmutexMySQLResult>(
    sql: string,
    values?: unknown[],
  ): Promise<[Result, unknown]> | [Result, unknown]
}

export type DmutexD1Result = {
  success?: boolean
  meta?: {
    changes?: number
  }
}

export type DmutexD1PreparedStatement = {
  bind(...values: unknown[]): DmutexD1PreparedStatement
  run(): Promise<DmutexD1Result> | DmutexD1Result
  first<Row = Record<string, unknown>>(): Promise<Row | null> | Row | null
}

export type DmutexD1Database = {
  prepare(sql: string): DmutexD1PreparedStatement
}

export type DMutexBackend = "mongodb" | "redis" | "postgresql" | "dynamodb" | "mysql" | "d1"

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

export type DynamoDBDMutexOptions = BaseDMutexOptions & {
  tableName?: string
  tablePrefix?: string
  createTable?: boolean
  readyTimeoutMs?: number
  readyPollIntervalMs?: number
}

export type MySQLDMutexOptions = BaseDMutexOptions & {
  databaseName?: string
  tableName?: string
  tablePrefix?: string
}

export type D1DMutexOptions = BaseDMutexOptions & {
  tableName?: string
  tablePrefix?: string
}

export type DMutexOptions =
  | MongoDMutexOptions
  | RedisDMutexOptions
  | PostgresDMutexOptions
  | DynamoDBDMutexOptions
  | MySQLDMutexOptions
  | D1DMutexOptions

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

export type DynamoDBDSemaphoreOptions = DynamoDBDMutexOptions & BaseDSemaphoreOptions

export type MySQLDSemaphoreOptions = MySQLDMutexOptions & BaseDSemaphoreOptions

export type D1DSemaphoreOptions = D1DMutexOptions & BaseDSemaphoreOptions

export type DSemaphoreOptions =
  | MongoDSemaphoreOptions
  | RedisDSemaphoreOptions
  | PostgresDSemaphoreOptions
  | DynamoDBDSemaphoreOptions
  | MySQLDSemaphoreOptions
  | D1DSemaphoreOptions

export type DSemaphoreWaitOptions = DMutexWaitOptions

export type DSemaphorePermit = {
  key: string
  token: string
  slot: number
  expiredAt: Date
  release: () => Promise<boolean>
  extend: (ttl?: number) => Promise<boolean>
}
