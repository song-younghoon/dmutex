import { DynamoDBDMutexStore } from "./dynamodb-store";
import { MongoDMutexStore } from "./mongo-store";
import { MySQLDMutexStore } from "./mysql-store";
import { PostgresDMutexStore } from "./postgres-store";
import { RedisDMutexStore } from "./redis-store";
import type { DMutexStore } from "./store";
import type {
  DmutexDynamoDBClient,
  DynamoDBDMutexOptions,
  DMutexBackend,
  DmutexMongoClient,
  DmutexMySQLClient,
  DmutexPostgresClient,
  DmutexRedisClient,
  DMutexOptions,
  MongoDMutexOptions,
  MySQLDMutexOptions,
  PostgresDMutexOptions,
  RedisDMutexOptions,
} from "./types";

const hasFunction = <T extends string>(
  value: unknown,
  name: T,
): value is Record<T, (...args: any[]) => unknown> => {
  return (
    typeof value === "object" &&
    value !== null &&
    name in value &&
    typeof (value as Record<T, unknown>)[name] === "function"
  );
}

const isMongoClient = (client: unknown): client is DmutexMongoClient => {
  return hasFunction(client, "db");
}

const isRedisClient = (client: unknown): client is DmutexRedisClient => {
  return hasFunction(client, "sendCommand") ||
    (hasFunction(client, "set") && hasFunction(client, "eval"));
}

const isPostgresClient = (client: unknown): client is DmutexPostgresClient => {
  return hasFunction(client, "query");
}

const isMySQLClient = (client: unknown): client is DmutexMySQLClient => {
  return hasFunction(client, "execute");
}

const isDynamoDBClient = (client: unknown): client is DmutexDynamoDBClient => {
  return hasFunction(client, "createTable") &&
    hasFunction(client, "describeTable") &&
    hasFunction(client, "putItem") &&
    hasFunction(client, "deleteItem") &&
    hasFunction(client, "updateItem");
}

const detectBackend = (
  client:
    | DmutexMongoClient
    | DmutexRedisClient
    | DmutexPostgresClient
    | DmutexDynamoDBClient
    | DmutexMySQLClient,
  explicitBackend?: DMutexBackend,
): DMutexBackend => {
  const matchesMongo = isMongoClient(client);
  const matchesRedis = isRedisClient(client);
  const matchesPostgresContract = isPostgresClient(client);
  const matchesMySQL = isMySQLClient(client);
  const matchesPostgres = matchesPostgresContract && !matchesMySQL;
  const matchesDynamoDB = isDynamoDBClient(client);

  if (
    explicitBackend !== undefined &&
    explicitBackend !== "mongodb" &&
    explicitBackend !== "redis" &&
    explicitBackend !== "postgresql" &&
    explicitBackend !== "dynamodb" &&
    explicitBackend !== "mysql"
  ) {
    throw new Error("dmutex backend must be mongodb, redis, postgresql, dynamodb, or mysql");
  }

  if (explicitBackend === "mongodb") {
    if (!matchesMongo) {
      throw new Error(
        "Cannot use MongoDB backend; client must provide MongoDB db()",
      );
    }
    return "mongodb";
  }

  if (explicitBackend === "redis") {
    if (!matchesRedis) {
      throw new Error(
        "Cannot use Redis backend; client must provide Redis sendCommand(args) or set(...args) plus eval(...args)",
      );
    }
    return "redis";
  }

  if (explicitBackend === "postgresql") {
    if (!matchesPostgresContract) {
      throw new Error(
        "Cannot use PostgreSQL backend; client must provide query(text, values)",
      );
    }
    return "postgresql";
  }

  if (explicitBackend === "dynamodb") {
    if (!matchesDynamoDB) {
      throw new Error(
        "Cannot use DynamoDB backend; client must provide createTable(), describeTable(), putItem(), deleteItem(), and updateItem()",
      );
    }
    return "dynamodb";
  }

  if (explicitBackend === "mysql") {
    if (!matchesMySQL) {
      throw new Error(
        "Cannot use MySQL backend; client must provide execute(sql, values)",
      );
    }
    return "mysql";
  }

  const matchingBackends: DMutexBackend[] = [];
  if (matchesMongo) {
    matchingBackends.push("mongodb");
  }
  if (matchesRedis) {
    matchingBackends.push("redis");
  }
  if (matchesPostgres) {
    matchingBackends.push("postgresql");
  }
  if (matchesDynamoDB) {
    matchingBackends.push("dynamodb");
  }
  if (matchesMySQL) {
    matchingBackends.push("mysql");
  }

  if (matchingBackends.length === 1) {
    return matchingBackends[0]!;
  }

  if (matchingBackends.length > 1) {
    throw new Error(
      "Cannot detect dmutex backend because the client matches multiple backend contracts",
    );
  }

  throw new Error(
    "Cannot detect dmutex backend; client must provide MongoDB db(), Redis sendCommand(args) / set(...args) plus eval(...args), PostgreSQL query(text, values), DynamoDB createTable()/describeTable()/putItem()/deleteItem()/updateItem(), or MySQL execute(sql, values)",
  );
}

export const createDMutexStore = (
  serviceName: string,
  client:
    | DmutexMongoClient
    | DmutexRedisClient
    | DmutexPostgresClient
    | DmutexDynamoDBClient
    | DmutexMySQLClient,
  options: DMutexOptions,
): DMutexStore => {
  const backend = detectBackend(client, options.backend);
  if (backend === "redis") {
    return new RedisDMutexStore(serviceName, client as DmutexRedisClient, options as RedisDMutexOptions);
  }
  if (backend === "postgresql") {
    return new PostgresDMutexStore(serviceName, client as DmutexPostgresClient, options as PostgresDMutexOptions);
  }
  if (backend === "dynamodb") {
    return new DynamoDBDMutexStore(serviceName, client as DmutexDynamoDBClient, options as DynamoDBDMutexOptions);
  }
  if (backend === "mysql") {
    return new MySQLDMutexStore(serviceName, client as DmutexMySQLClient, options as MySQLDMutexOptions);
  }

  return new MongoDMutexStore(serviceName, client as DmutexMongoClient, options as MongoDMutexOptions);
}
