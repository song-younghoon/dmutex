import type {
  DmutexPostgresClient,
  PostgresDMutexOptions,
} from "./types";
import type { DMutexStore } from "./store";

type ExpirationRow = {
  expired_at: Date | string
}

const quoteIdentifier = (identifier: string) => {
  if (identifier.length === 0 || identifier.includes("\0")) {
    throw new Error("PostgreSQL identifiers must be non-empty strings without null bytes");
  }

  return `"${identifier.replaceAll('"', '""')}"`;
}

const toDate = (value: Date | string) => {
  return value instanceof Date ? value : new Date(value);
}

export class PostgresDMutexStore implements DMutexStore {
  private postgresClient: DmutexPostgresClient
  private tableName: string
  private indexName: string
  private table: string
  private readyPromise: Promise<void>

  constructor(serviceName: string, postgresClient: DmutexPostgresClient, options: PostgresDMutexOptions) {
    this.postgresClient = postgresClient;
    this.tableName = options.tableName ?? `${options.tablePrefix ?? "_dmutex_"}${serviceName}`;
    this.indexName = `${this.tableName}_expired_at_idx`;
    this.table = options.schemaName
      ? `${quoteIdentifier(options.schemaName)}.${quoteIdentifier(this.tableName)}`
      : quoteIdentifier(this.tableName);
    this.readyPromise = this.initialize();
  }

  public ready = async () => {
    await this.readyPromise;
  }

  private query = async <Row = Record<string, unknown>>(text: string, values?: unknown[]) => {
    return await this.postgresClient.query<Row>(text, values);
  }

  private initialize = async () => {
    await this.query(`
      CREATE TABLE IF NOT EXISTS ${this.table} (
        "key" text PRIMARY KEY,
        "value" text NOT NULL,
        "expired_at" timestamptz NOT NULL
      )
    `);

    await this.query(`
      CREATE INDEX IF NOT EXISTS ${quoteIdentifier(this.indexName)}
      ON ${this.table} ("expired_at")
    `);
  }

  public acquire = async (key: string, token: string, ttlSeconds: number) => {
    await this.ready();

    const result = await this.query<ExpirationRow>(`
      INSERT INTO ${this.table} AS locks ("key", "value", "expired_at")
      VALUES ($1, $2, NOW() + ($3::double precision * INTERVAL '1 second'))
      ON CONFLICT ("key") DO UPDATE
      SET
        "value" = EXCLUDED."value",
        "expired_at" = EXCLUDED."expired_at"
      WHERE locks."expired_at" <= NOW()
      RETURNING "expired_at"
    `, [key, token, ttlSeconds]);

    const row = result.rows[0];
    return row ? toDate(row.expired_at) : null;
  }

  public release = async (key: string, token: string) => {
    await this.ready();

    const result = await this.query(`
      DELETE FROM ${this.table}
      WHERE "key" = $1 AND "value" = $2
    `, [key, token]);

    return result.rowCount === 1;
  }

  public extend = async (key: string, token: string, ttlSeconds: number) => {
    await this.ready();

    const result = await this.query<ExpirationRow>(`
      UPDATE ${this.table}
      SET "expired_at" = NOW() + ($3::double precision * INTERVAL '1 second')
      WHERE "key" = $1
        AND "value" = $2
        AND "expired_at" > NOW()
      RETURNING "expired_at"
    `, [key, token, ttlSeconds]);

    const row = result.rows[0];
    return row ? toDate(row.expired_at) : null;
  }
}
