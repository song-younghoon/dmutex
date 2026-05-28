import { MongoDMutexStore } from "./mongo-store";
import { RedisDMutexStore } from "./redis-store";
import type { DMutexStore } from "./store";
import type {
  DMutexBackend,
  DmutexMongoClient,
  DmutexRedisClient,
  DMutexOptions,
  MongoDMutexOptions,
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

const detectBackend = (
  client: DmutexMongoClient | DmutexRedisClient,
  explicitBackend?: DMutexBackend,
) => {
  const matchesMongo = isMongoClient(client);
  const matchesRedis = isRedisClient(client);

  if (
    explicitBackend !== undefined &&
    explicitBackend !== "mongodb" &&
    explicitBackend !== "redis"
  ) {
    throw new Error("dmutex backend must be either mongodb or redis");
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

  if (matchesMongo && !matchesRedis) {
    return "mongodb";
  }

  if (matchesRedis && !matchesMongo) {
    return "redis";
  }

  if (matchesMongo && matchesRedis) {
    throw new Error(
      "Cannot detect dmutex backend because the client matches both MongoDB and Redis contracts",
    );
  }

  throw new Error(
    "Cannot detect dmutex backend; client must provide MongoDB db() or Redis sendCommand(args) / set(...args) plus eval(...args)",
  );
}

export const createDMutexStore = (
  serviceName: string,
  client: DmutexMongoClient | DmutexRedisClient,
  options: DMutexOptions,
): DMutexStore => {
  const backend = detectBackend(client, options.backend);
  return backend === "redis"
    ? new RedisDMutexStore(serviceName, client as DmutexRedisClient, options as RedisDMutexOptions)
    : new MongoDMutexStore(serviceName, client as DmutexMongoClient, options as MongoDMutexOptions);
}
