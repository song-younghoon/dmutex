import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  CreateTableCommand,
  DeleteItemCommand,
  DeleteTableCommand,
  DescribeTableCommand,
  DynamoDBClient,
  GetItemCommand,
  ListTablesCommand,
  PutItemCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import { DMutex, type DmutexDynamoDBClient } from "../../src/mutex";

const dynamoDBEndpoint = process.env.DYNAMODB_ENDPOINT || "http://localhost:8000";
const describeIntegration = process.env.DMUTEX_INTEGRATION === "1" ? describe : describe.skip;
const mutexSlotKey = (key: string) => `permit:0:${key}`;

class AwsDynamoDBClient implements DmutexDynamoDBClient {
  constructor(private client: DynamoDBClient) {}

  public createTable = async (input: Record<string, unknown>) => {
    return await this.client.send(new CreateTableCommand(input));
  }

  public describeTable = async (input: Record<string, unknown>) => {
    return await this.client.send(new DescribeTableCommand(input));
  }

  public putItem = async (input: Record<string, unknown>) => {
    return await this.client.send(new PutItemCommand(input));
  }

  public deleteItem = async (input: Record<string, unknown>) => {
    return await this.client.send(new DeleteItemCommand(input));
  }

  public updateItem = async (input: Record<string, unknown>) => {
    return await this.client.send(new UpdateItemCommand(input));
  }
}

const requireDynamoDB = async (client: DynamoDBClient) => {
  let lastError: unknown;

  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await client.send(new ListTablesCommand({ Limit: 1 }));
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  throw new Error(
    `DynamoDB is required for integration tests. Start DynamoDB Local or set DYNAMODB_ENDPOINT. Tried: ${dynamoDBEndpoint}`,
    { cause: lastError },
  );
}

describeIntegration("DMutex DynamoDB integration", () => {
  let rawClient: DynamoDBClient | undefined;
  let mutex: DMutex;
  const tableName = `dmutex-test-service-${process.pid}`;

  beforeAll(async () => {
    rawClient = new DynamoDBClient({
      endpoint: dynamoDBEndpoint,
      region: "us-east-1",
      credentials: {
        accessKeyId: "test",
        secretAccessKey: "test",
      },
    });

    await requireDynamoDB(rawClient);

    mutex = new DMutex("test-service", new AwsDynamoDBClient(rawClient), {
      backend: "dynamodb",
      tableName,
      readyTimeoutMs: 10_000,
    });
    await mutex.ready();
  });

  afterAll(async () => {
    if (!rawClient) {
      return;
    }

    await rawClient.send(new DeleteTableCommand({ TableName: tableName })).catch(() => {});
    rawClient.destroy();
  });

  test("should acquire lock successfully", async () => {
    const result = await mutex.lock("test-key-1");
    expect(result).toBe(true);

    await mutex.unlock("test-key-1");
  });

  test("should fail to acquire lock when already locked", async () => {
    const key = "test-key-2";

    expect(await mutex.lock(key)).toBe(true);
    expect(await mutex.lock(key)).toBe(false);

    await mutex.unlock(key);
  });

  test("should store expiration correctly", async () => {
    const key = "test-key-ttl";

    expect(await mutex.lock(key, 5)).toBe(true);

    const result = await rawClient!.send(new GetItemCommand({
      TableName: tableName,
      Key: {
        key: { S: mutexSlotKey(key) },
      },
    }));

    const expiredAt = Number(result.Item?.expiredAt?.N);
    expect(Number.isFinite(expiredAt)).toBe(true);

    const diff = expiredAt - Date.now();
    expect(diff).toBeGreaterThan(4000);
    expect(diff).toBeLessThan(6000);

    await mutex.unlock(key);
  });

  test("should handle concurrent lock attempts", async () => {
    const key = "test-key-concurrent";

    const results = await Promise.all([
      mutex.lock(key),
      mutex.lock(key),
      mutex.lock(key),
    ]);

    const successCount = results.filter((result) => result === true).length;
    expect(successCount).toBe(1);

    await mutex.unlock(key);
  });

  test("should not release a lock owned by another token", async () => {
    const key = "test-key-token";
    const firstLock = await mutex.acquire(key, 30);
    expect(firstLock).not.toBeNull();

    const releasedByWrongOwner = await mutex.unlock(key, "wrong-token");
    expect(releasedByWrongOwner).toBe(false);

    const secondLockAttempt = await mutex.acquire(key, 30);
    expect(secondLockAttempt).toBeNull();

    await firstLock!.release();
  });

  test("should allow takeover of expired lock without cleanup", async () => {
    const key = "test-key-expired-takeover";
    const firstLock = await mutex.acquire(key, 30);
    expect(firstLock).not.toBeNull();

    await rawClient!.send(new UpdateItemCommand({
      TableName: tableName,
      Key: {
        key: { S: mutexSlotKey(key) },
      },
      UpdateExpression: "SET expiredAt = :expiredAt",
      ExpressionAttributeValues: {
        ":expiredAt": { N: String(Date.now() - 1000) },
      },
    }));

    const secondLock = await mutex.acquire(key, 30);
    expect(secondLock).not.toBeNull();
    expect(secondLock!.token).not.toBe(firstLock!.token);

    const staleRelease = await firstLock!.release();
    expect(staleRelease).toBe(false);

    const result = await rawClient!.send(new GetItemCommand({
      TableName: tableName,
      Key: {
        key: { S: mutexSlotKey(key) },
      },
    }));
    expect(result.Item?.value?.S).toBe(secondLock!.token);

    await secondLock!.release();
  });

  test("should extend only an active owned lock", async () => {
    const key = "test-key-extend";
    const lock = await mutex.acquire(key, 5);
    expect(lock).not.toBeNull();

    expect(await lock!.extend(30)).toBe(true);
    expect(await mutex.extend(key, "wrong-token", 30)).toBe(false);

    await lock!.release();
  });
});
