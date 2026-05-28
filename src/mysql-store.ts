import type {
  DmutexMySQLClient,
  DmutexMySQLResult,
  MySQLDMutexOptions,
} from "./types";
import type { DMutexStore } from "./store";

type MySQLLockRow = {
  value: string
  expired_at: number | string
}

const quoteIdentifier = (identifier: string) => {
  if (identifier.length === 0 || identifier.includes("\0")) {
    throw new Error("MySQL identifiers must be non-empty strings without null bytes");
  }

  return `\`${identifier.replaceAll("`", "``")}\``;
}

const affectedRows = (result: DmutexMySQLResult | unknown) => {
  if (
    typeof result === "object" &&
    result !== null &&
    "affectedRows" in result &&
    typeof (result as { affectedRows?: unknown }).affectedRows === "number"
  ) {
    return (result as { affectedRows: number }).affectedRows;
  }

  return 0;
}

export class MySQLDMutexStore implements DMutexStore {
  private mysqlClient: DmutexMySQLClient
  private table: string
  private readyPromise: Promise<void>

  constructor(serviceName: string, mysqlClient: DmutexMySQLClient, options: MySQLDMutexOptions) {
    this.mysqlClient = mysqlClient;
    const tableName = options.tableName ?? `${options.tablePrefix ?? "_dmutex_"}${serviceName}`;
    this.table = options.databaseName
      ? `${quoteIdentifier(options.databaseName)}.${quoteIdentifier(tableName)}`
      : quoteIdentifier(tableName);
    this.readyPromise = this.initialize();
  }

  public ready = async () => {
    await this.readyPromise;
  }

  private execute = async <Result = DmutexMySQLResult>(sql: string, values?: unknown[]) => {
    const [result] = await this.mysqlClient.execute<Result>(sql, values);
    return result;
  }

  private initialize = async () => {
    await this.execute(`
      CREATE TABLE IF NOT EXISTS ${this.table} (
        \`key\` varchar(512) NOT NULL,
        \`value\` varchar(128) NOT NULL,
        \`expired_at\` bigint NOT NULL,
        PRIMARY KEY (\`key\`),
        INDEX \`expired_at_idx\` (\`expired_at\`)
      ) ENGINE=InnoDB
    `);
  }

  public acquire = async (key: string, token: string, ttlSeconds: number) => {
    await this.ready();

    const now = Date.now();
    const expiredAt = new Date(now + (ttlSeconds * 1000));
    await this.execute(`
      INSERT INTO ${this.table} (\`key\`, \`value\`, \`expired_at\`)
      VALUES (?, ?, ?)
      ON DUPLICATE KEY UPDATE
        \`value\` = IF(\`expired_at\` <= ?, VALUES(\`value\`), \`value\`),
        \`expired_at\` = IF(\`expired_at\` <= ?, VALUES(\`expired_at\`), \`expired_at\`)
    `, [key, token, expiredAt.getTime(), now, now]);

    const rows = await this.execute<MySQLLockRow[]>(`
      SELECT \`value\`, \`expired_at\`
      FROM ${this.table}
      WHERE \`key\` = ?
    `, [key]);
    const row = rows[0];

    return row?.value === token ? new Date(Number(row.expired_at)) : null;
  }

  public release = async (key: string, token: string) => {
    await this.ready();

    const result = await this.execute(`
      DELETE FROM ${this.table}
      WHERE \`key\` = ? AND \`value\` = ?
    `, [key, token]);

    return affectedRows(result) === 1;
  }

  public extend = async (key: string, token: string, ttlSeconds: number) => {
    await this.ready();

    const now = Date.now();
    const expiredAt = new Date(now + (ttlSeconds * 1000));
    const result = await this.execute(`
      UPDATE ${this.table}
      SET \`expired_at\` = ?
      WHERE \`key\` = ?
        AND \`value\` = ?
        AND \`expired_at\` > ?
    `, [expiredAt.getTime(), key, token, now]);

    return affectedRows(result) === 1 ? expiredAt : null;
  }
}
