import { describe, expect, test } from "bun:test";
import {
  DMutex,
  type DmutexMongoCollection,
  type DmutexMongoCollectionDocument,
} from "../../src/mutex";

class FakeMongoCollection implements DmutexMongoCollection {
  public documents = new Map<string, DmutexMongoCollectionDocument>()
  public nextInsertError: unknown

  public createIndex = async () => "expiredAt_1"

  public insertOne = async (document: DmutexMongoCollectionDocument) => {
    if (this.nextInsertError) {
      const error = this.nextInsertError;
      this.nextInsertError = undefined;
      throw error;
    }

    if (this.documents.has(document._id)) {
      throw Object.assign(new Error("duplicate key"), { code: 11000 });
    }

    this.documents.set(document._id, {
      ...document,
      expiredAt: new Date(document.expiredAt),
    });
  }

  public updateOne = async (
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
  ) => {
    const key = String(filter._id);
    const document = this.documents.get(key);
    if (!document || !this.matches(document, filter)) {
      return { matchedCount: 0 };
    }

    const nextValues = update.$set as Partial<DmutexMongoCollectionDocument> | undefined;
    if (nextValues?.value) {
      document.value = nextValues.value;
    }
    if (nextValues?.expiredAt) {
      document.expiredAt = new Date(nextValues.expiredAt);
    }

    return { matchedCount: 1 };
  }

  public deleteOne = async (filter: Record<string, unknown>) => {
    const key = String(filter._id);
    const document = this.documents.get(key);
    if (!document || !this.matches(document, filter)) {
      return { deletedCount: 0 };
    }

    this.documents.delete(key);
    return { deletedCount: 1 };
  }

  private matches = (
    document: DmutexMongoCollectionDocument,
    filter: Record<string, unknown>,
  ) => {
    if ("value" in filter && filter.value !== document.value) {
      return false;
    }

    const expiredAtFilter = filter.expiredAt;
    if (isDateComparison(expiredAtFilter, "$lte")) {
      return document.expiredAt.getTime() <= expiredAtFilter.$lte.getTime();
    }
    if (isDateComparison(expiredAtFilter, "$gt")) {
      return document.expiredAt.getTime() > expiredAtFilter.$gt.getTime();
    }

    return true;
  }
}

class FakeMongoClient {
  public collection = new FakeMongoCollection()

  public db = () => ({
    collection: () => this.collection,
  })
}

const isDateComparison = <T extends "$lte" | "$gt">(
  value: unknown,
  operator: T,
): value is Record<T, Date> => {
  return (
    typeof value === "object" &&
    value !== null &&
    operator in value &&
    (value as Record<T, unknown>)[operator] instanceof Date
  );
}

describe("Mongo mutex backend unit", () => {
  test("supports lock, contention, and release without a real MongoDB server", async () => {
    const client = new FakeMongoClient();
    const mutex = new DMutex("test-service", client);

    expect(await mutex.lock("shared-key", 30)).toBe(true);
    expect(await mutex.lock("shared-key", 30)).toBe(false);
    expect(await mutex.unlock("shared-key")).toBe(true);
    expect(await mutex.lock("shared-key", 30)).toBe(true);
  });

  test("allows atomic takeover of an expired document", async () => {
    const client = new FakeMongoClient();
    const firstMutex = new DMutex("test-service", client);
    const secondMutex = new DMutex("test-service", client);

    const firstLock = await firstMutex.acquire("expired-key", 30);
    expect(firstLock).not.toBeNull();

    client.collection.documents.get("expired-key")!.expiredAt = new Date(Date.now() - 1000);

    const secondLock = await secondMutex.acquire("expired-key", 30);
    expect(secondLock).not.toBeNull();
    expect(secondLock!.token).not.toBe(firstLock!.token);
    expect(await firstLock!.release()).toBe(false);
    expect(client.collection.documents.get("expired-key")?.value).toBe(secondLock!.token);
  });

  test("rethrows unexpected insert errors", async () => {
    const client = new FakeMongoClient();
    const mutex = new DMutex("test-service", client);
    client.collection.nextInsertError = new Error("network unavailable");

    await expect(mutex.acquire("error-key", 30)).rejects.toThrow("network unavailable");
  });

  test("explicit backend resolves an otherwise ambiguous client", async () => {
    const client = Object.assign(new FakeMongoClient(), {
      sendCommand: async () => "OK",
    });
    const mutex = new DMutex("test-service", client, { backend: "mongodb" });

    expect(await mutex.lock("ambiguous-key", 30)).toBe(true);
  });

  test("legacy unlock clears stale local ownership after takeover", async () => {
    const client = new FakeMongoClient();
    const firstMutex = new DMutex("test-service", client);
    const secondMutex = new DMutex("test-service", client);

    expect(await firstMutex.lock("stale-key", 30)).toBe(true);
    client.collection.documents.get("stale-key")!.expiredAt = new Date(Date.now() - 1000);

    const secondLock = await secondMutex.acquire("stale-key", 30);
    expect(secondLock).not.toBeNull();
    expect(await firstMutex.unlock("stale-key")).toBe(false);
    expect((firstMutex as unknown as { lockTokens: Map<string, string> }).lockTokens.has("stale-key")).toBe(false);
  });
});
