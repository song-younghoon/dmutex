import type {
  D1DMutexOptions,
  DmutexD1Database,
  DmutexD1Result,
} from "./types";
import type { DMutexStore } from "./store";

type D1LockRow = {
  value: string
  expired_at: number
}

const quoteIdentifier = (identifier: string) => {
  if (identifier.length === 0 || identifier.includes("\0")) {
    throw new Error("D1 identifiers must be non-empty strings without null bytes");
  }

  return `"${identifier.replaceAll('"', '""')}"`;
}

const changedRows = (result: DmutexD1Result) => {
  return result.meta?.changes ?? 0;
}

export class D1DMutexStore implements DMutexStore {
  private d1Database: DmutexD1Database
  private table: string
  private indexName: string
  private readyPromise: Promise<void>

  constructor(serviceName: string, d1Database: DmutexD1Database, options: D1DMutexOptions) {
    this.d1Database = d1Database;
    const tableName = options.tableName ?? `${options.tablePrefix ?? "_dmutex_"}${serviceName}`;
    this.table = quoteIdentifier(tableName);
    this.indexName = `${tableName}_expired_at_idx`;
    this.readyPromise = this.initialize();
  }

  public ready = async () => {
    await this.readyPromise;
  }

  private run = async (sql: string, values: unknown[] = []) => {
    return await this.d1Database.prepare(sql).bind(...values).run();
  }

  private first = async <Row = Record<string, unknown>>(sql: string, values: unknown[] = []) => {
    return await this.d1Database.prepare(sql).bind(...values).first<Row>();
  }

  private initialize = async () => {
    await this.run(`
      CREATE TABLE IF NOT EXISTS ${this.table} (
        "key" TEXT PRIMARY KEY,
        "value" TEXT NOT NULL,
        "expired_at" INTEGER NOT NULL
      )
    `);

    await this.run(`
      CREATE INDEX IF NOT EXISTS ${quoteIdentifier(this.indexName)}
      ON ${this.table} ("expired_at")
    `);
  }

  public acquire = async (key: string, token: string, ttlSeconds: number) => {
    await this.ready();

    const now = Date.now();
    const expiredAt = new Date(now + (ttlSeconds * 1000));
    await this.run(`
      INSERT INTO ${this.table} ("key", "value", "expired_at")
      VALUES (?, ?, ?)
      ON CONFLICT("key") DO UPDATE
      SET
        "value" = excluded."value",
        "expired_at" = excluded."expired_at"
      WHERE "expired_at" <= ?
    `, [key, token, expiredAt.getTime(), now]);

    const row = await this.first<D1LockRow>(`
      SELECT "value", "expired_at"
      FROM ${this.table}
      WHERE "key" = ?
    `, [key]);

    return row?.value === token ? new Date(Number(row.expired_at)) : null;
  }

  public release = async (key: string, token: string) => {
    await this.ready();

    const result = await this.run(`
      DELETE FROM ${this.table}
      WHERE "key" = ? AND "value" = ?
    `, [key, token]);

    return changedRows(result) === 1;
  }

  public extend = async (key: string, token: string, ttlSeconds: number) => {
    await this.ready();

    const now = Date.now();
    const expiredAt = new Date(now + (ttlSeconds * 1000));
    const result = await this.run(`
      UPDATE ${this.table}
      SET "expired_at" = ?
      WHERE "key" = ?
        AND "value" = ?
        AND "expired_at" > ?
    `, [expiredAt.getTime(), key, token, now]);

    return changedRows(result) === 1 ? expiredAt : null;
  }
}
