import { MongoDMutexStore } from "./mongo-store";
import { PostgresDMutexStore } from "./postgres-store";
import { RedisDMutexStore } from "./redis-store";
import type { DMutexStore } from "./store";
import type {
  DMutexBackend,
  DmutexMongoClient,
  DmutexPostgresClient,
  DmutexRedisClient,
  DMutexOptions,
  MongoDMutexOptions,
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

const detectBackend = (
  client: DmutexMongoClient | DmutexRedisClient | DmutexPostgresClient,
  explicitBackend?: DMutexBackend,
) : DMutexBackend => {
  const matchesMongo = isMongoClient(client);
  const matchesRedis = isRedisClient(client);
  const matchesPostgres = isPostgresClient(client);

  if (
    explicitBackend !== undefined &&
    explicitBackend !== "mongodb" &&
    explicitBackend !== "redis" &&
    explicitBackend !== "postgresql"
  ) {
    throw new Error("dmutex backend must be mongodb, redis, or postgresql");
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
    if (!matchesPostgres) {
      throw new Error(
        "Cannot use PostgreSQL backend; client must provide query(text, values)",
      );
    }
    return "postgresql";
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

  if (matchingBackends.length === 1) {
    return matchingBackends[0]!;
  }

  if (matchingBackends.length > 1) {
    throw new Error(
      "Cannot detect dmutex backend because the client matches multiple backend contracts",
    );
  }

  throw new Error(
    "Cannot detect dmutex backend; client must provide MongoDB db(), Redis sendCommand(args) / set(...args) plus eval(...args), or PostgreSQL query(text, values)",
  );
}

export const createDMutexStore = (
  serviceName: string,
  client: DmutexMongoClient | DmutexRedisClient | DmutexPostgresClient,
  options: DMutexOptions,
): DMutexStore => {
  const backend = detectBackend(client, options.backend);
  if (backend === "redis") {
    return new RedisDMutexStore(serviceName, client as DmutexRedisClient, options as RedisDMutexOptions);
  }
  if (backend === "postgresql") {
    return new PostgresDMutexStore(serviceName, client as DmutexPostgresClient, options as PostgresDMutexOptions);
  }

  return new MongoDMutexStore(serviceName, client as DmutexMongoClient, options as MongoDMutexOptions);
}
