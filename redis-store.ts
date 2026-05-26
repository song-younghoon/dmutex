import type { DmutexRedisClient, RedisDMutexOptions } from "./types";
import type { DMutexStore } from "./store";

const RELEASE_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
else
  return 0
end
`;

const EXTEND_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("PEXPIRE", KEYS[1], ARGV[2])
else
  return 0
end
`;

const toBooleanResult = (result: unknown) => {
  return result === 1 || result === true || result === "1" || result === "OK";
}

export class RedisDMutexStore implements DMutexStore {
  private redisClient: DmutexRedisClient
  private keyPrefix: string

  constructor(serviceName: string, redisClient: DmutexRedisClient, options: RedisDMutexOptions) {
    this.redisClient = redisClient;
    this.keyPrefix = options.keyPrefix ?? `_dmutex_${serviceName}:`;
  }

  public ready = async () => {}

  private key = (key: string) => `${this.keyPrefix}${key}`

  private command = async (args: string[]) => {
    if (
      "sendCommand" in this.redisClient &&
      this.redisClient.sendCommand &&
      !("status" in this.redisClient)
    ) {
      return await this.redisClient.sendCommand(args);
    }

    const command = args[0]?.toLowerCase();
    if (command === "set" && "set" in this.redisClient && this.redisClient.set) {
      return await this.redisClient.set(...args.slice(1));
    }

    if (command === "eval" && "eval" in this.redisClient && this.redisClient.eval) {
      return await this.redisClient.eval(...args.slice(1));
    }

    if (!command) {
      throw new Error("Redis client must provide sendCommand(args) or set/eval methods");
    }
    throw new Error(`Redis client does not provide ${command}()`);
  }

  public acquire = async (key: string, token: string, ttlSeconds: number) => {
    const ttlMs = Math.ceil(ttlSeconds * 1000);
    const expiredAt = new Date(Date.now() + ttlMs);
    const result = await this.command([
      "SET",
      this.key(key),
      token,
      "PX",
      String(ttlMs),
      "NX",
    ]);

    return toBooleanResult(result) ? expiredAt : null;
  }

  public release = async (key: string, token: string) => {
    const result = await this.command([
      "EVAL",
      RELEASE_SCRIPT,
      "1",
      this.key(key),
      token,
    ]);

    return toBooleanResult(result);
  }

  public extend = async (key: string, token: string, ttlSeconds: number) => {
    const ttlMs = Math.ceil(ttlSeconds * 1000);
    const result = await this.command([
      "EVAL",
      EXTEND_SCRIPT,
      "1",
      this.key(key),
      token,
      String(ttlMs),
    ]);

    return toBooleanResult(result);
  }
}
