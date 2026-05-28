import { describe, expect, test } from "bun:test";
import {
  DMutex,
  DSemaphore,
  type DmutexDynamoDBAttributeValue,
  type DmutexDynamoDBClient,
} from "../../src";

type DynamoDBRow = {
  key: string
  value: string
  expiredAt: number
}

const namedError = (name: string) => Object.assign(new Error(name), { name });

class FakeDynamoDBClient implements DmutexDynamoDBClient {
  public rows = new Map<string, DynamoDBRow>()
  private tableCreated = false

  public createTable = async () => {
    if (this.tableCreated) {
      throw namedError("ResourceInUseException");
    }

    this.tableCreated = true;
  }

  public describeTable = async () => {
    if (!this.tableCreated) {
      throw namedError("ResourceNotFoundException");
    }

    return {
      Table: {
        TableStatus: "ACTIVE",
      },
    };
  }

  public putItem = async (input: Record<string, unknown>) => {
    const item = input.Item as Record<string, DmutexDynamoDBAttributeValue>;
    const key = this.stringValue(item.key);
    const value = this.stringValue(item.value);
    const expiredAt = this.numberValue(item.expiredAt);
    const now = this.numberValue((input.ExpressionAttributeValues as Record<string, DmutexDynamoDBAttributeValue>)[":now"]);
    const existing = this.rows.get(key);

    if (existing && existing.expiredAt > now) {
      throw namedError("ConditionalCheckFailedException");
    }

    this.rows.set(key, { key, value, expiredAt });
  }

  public deleteItem = async (input: Record<string, unknown>) => {
    const key = this.stringValue((input.Key as Record<string, DmutexDynamoDBAttributeValue>).key);
    const token = this.stringValue((input.ExpressionAttributeValues as Record<string, DmutexDynamoDBAttributeValue>)[":token"]);
    const existing = this.rows.get(key);

    if (!existing || existing.value !== token) {
      throw namedError("ConditionalCheckFailedException");
    }

    this.rows.delete(key);
  }

  public updateItem = async (input: Record<string, unknown>) => {
    const key = this.stringValue((input.Key as Record<string, DmutexDynamoDBAttributeValue>).key);
    const values = input.ExpressionAttributeValues as Record<string, DmutexDynamoDBAttributeValue>;
    const token = this.stringValue(values[":token"]);
    const now = this.numberValue(values[":now"]);
    const expiredAt = this.numberValue(values[":expiredAt"]);
    const existing = this.rows.get(key);

    if (!existing || existing.value !== token || existing.expiredAt <= now) {
      throw namedError("ConditionalCheckFailedException");
    }

    existing.expiredAt = expiredAt;

    return {
      Attributes: {
        expiredAt: { N: String(expiredAt) },
      },
    };
  }

  private stringValue = (attribute: DmutexDynamoDBAttributeValue | undefined) => {
    if (!attribute?.S) {
      throw new Error("Expected DynamoDB string attribute");
    }

    return attribute.S;
  }

  private numberValue = (attribute: DmutexDynamoDBAttributeValue | undefined) => {
    if (!attribute?.N) {
      throw new Error("Expected DynamoDB number attribute");
    }

    return Number(attribute.N);
  }
}

const mutexSlotKey = (key: string) => `permit:0:${key}`;

describe("DynamoDB mutex backend unit", () => {
  test("supports lock, contention, and release without a real DynamoDB service", async () => {
    const client = new FakeDynamoDBClient();
    const mutex = new DMutex("test-service", client);

    expect(await mutex.lock("shared-key", 30)).toBe(true);
    expect(await mutex.lock("shared-key", 30)).toBe(false);
    expect(await mutex.unlock("shared-key")).toBe(true);
    expect(await mutex.lock("shared-key", 30)).toBe(true);
  });

  test("allows atomic takeover of an expired item", async () => {
    const client = new FakeDynamoDBClient();
    const firstMutex = new DMutex("test-service", client);
    const secondMutex = new DMutex("test-service", client);

    const firstLock = await firstMutex.acquire("expired-key", 30);
    expect(firstLock).not.toBeNull();

    client.rows.get(mutexSlotKey("expired-key"))!.expiredAt = Date.now() - 1000;

    const secondLock = await secondMutex.acquire("expired-key", 30);
    expect(secondLock).not.toBeNull();
    expect(secondLock!.token).not.toBe(firstLock!.token);
    expect(await firstLock!.release()).toBe(false);
    expect(client.rows.get(mutexSlotKey("expired-key"))?.value).toBe(secondLock!.token);

    await secondLock!.release();
  });

  test("extends only an active owned lock", async () => {
    const client = new FakeDynamoDBClient();
    const mutex = new DMutex("test-service", client);

    const lock = await mutex.acquire("extend-key", 1);
    expect(lock).not.toBeNull();
    const originalExpiredAt = lock!.expiredAt.getTime();

    expect(await mutex.extend("extend-key", "wrong-token", 60)).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(await lock!.extend(60)).toBe(true);
    expect(lock!.expiredAt.getTime()).toBeGreaterThan(originalExpiredAt);

    await lock!.release();
  });

  test("supports semaphore permits through the DynamoDB backend", async () => {
    const client = new FakeDynamoDBClient();
    const semaphore = new DSemaphore("test-service", client, { maxPermits: 2 });

    const firstPermit = await semaphore.acquire("shared-key", 30);
    const secondPermit = await semaphore.acquire("shared-key", 30);
    const contestedPermit = await semaphore.acquire("shared-key", 30);

    expect(firstPermit).not.toBeNull();
    expect(secondPermit).not.toBeNull();
    expect(contestedPermit).toBeNull();

    await firstPermit!.release();
    await secondPermit!.release();
  });

  test("explicit backend resolves an otherwise ambiguous client", async () => {
    const client = Object.assign(new FakeDynamoDBClient(), {
      sendCommand: async () => "OK",
    });
    const mutex = new DMutex("test-service", client, { backend: "dynamodb" });

    const lock = await mutex.acquire("explicit-backend-key", 30);
    expect(lock).not.toBeNull();
    await lock!.release();
  });
});
