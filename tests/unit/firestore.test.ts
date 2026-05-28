import { describe, expect, test } from "bun:test";
import {
  DMutex,
  DSemaphore,
  type DmutexFirestoreClient,
  type DmutexFirestoreCollection,
  type DmutexFirestoreDocumentReference,
  type DmutexFirestoreDocumentSnapshot,
  type DmutexFirestoreTransaction,
} from "../../src";

type FirestoreRow = {
  value: string
  expiredAt: number
}

class FakeFirestoreSnapshot implements DmutexFirestoreDocumentSnapshot {
  constructor(private row: FirestoreRow | undefined) {}

  public get exists() {
    return this.row !== undefined;
  }

  public data = () => this.row
    ? {
        value: this.row.value,
        expiredAt: this.row.expiredAt,
      }
    : undefined
}

class FakeFirestoreTransaction implements DmutexFirestoreTransaction {
  constructor(private rows: Map<string, FirestoreRow>) {}

  public get = async (ref: DmutexFirestoreDocumentReference) => {
    return new FakeFirestoreSnapshot(this.rows.get(String(ref)));
  }

  public set = (ref: DmutexFirestoreDocumentReference, data: Record<string, unknown>) => {
    this.rows.set(String(ref), {
      value: String(data.value),
      expiredAt: Number(data.expiredAt),
    });
  }

  public delete = (ref: DmutexFirestoreDocumentReference) => {
    this.rows.delete(String(ref));
  }
}

class FakeFirestoreCollection implements DmutexFirestoreCollection {
  constructor(private collectionName: string) {}

  public doc = (path: string) => `${this.collectionName}/${path}`
}

class FakeFirestoreClient implements DmutexFirestoreClient {
  public rows = new Map<string, FirestoreRow>()

  public collection = (path: string) => new FakeFirestoreCollection(path)

  public runTransaction = async <T>(callback: (transaction: DmutexFirestoreTransaction) => Promise<T>) => {
    return await callback(new FakeFirestoreTransaction(this.rows));
  }
}

const mutexSlotKey = (key: string) => `permit:0:${key}`;

const documentKey = (key: string) => `_dmutex_test-service/${encodeURIComponent(mutexSlotKey(key))}`;

describe("Firestore mutex backend unit", () => {
  test("supports lock, contention, and release without a real Firestore service", async () => {
    const client = new FakeFirestoreClient();
    const mutex = new DMutex("test-service", client);

    expect(await mutex.lock("shared-key", 30)).toBe(true);
    expect(await mutex.lock("shared-key", 30)).toBe(false);
    expect(await mutex.unlock("shared-key")).toBe(true);
    expect(await mutex.lock("shared-key", 30)).toBe(true);
  });

  test("allows atomic takeover of an expired document", async () => {
    const client = new FakeFirestoreClient();
    const firstMutex = new DMutex("test-service", client);
    const secondMutex = new DMutex("test-service", client);

    const firstLock = await firstMutex.acquire("expired-key", 30);
    expect(firstLock).not.toBeNull();

    client.rows.get(documentKey("expired-key"))!.expiredAt = Date.now() - 1000;

    const secondLock = await secondMutex.acquire("expired-key", 30);
    expect(secondLock).not.toBeNull();
    expect(secondLock!.token).not.toBe(firstLock!.token);
    expect(await firstLock!.release()).toBe(false);
    expect(client.rows.get(documentKey("expired-key"))?.value).toBe(secondLock!.token);

    await secondLock!.release();
  });

  test("extends only an active owned lock", async () => {
    const client = new FakeFirestoreClient();
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

  test("supports semaphore permits through the Firestore backend", async () => {
    const client = new FakeFirestoreClient();
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
    const client = Object.assign(new FakeFirestoreClient(), {
      query: async () => ({ rows: [] }),
    });
    const mutex = new DMutex("test-service", client, { backend: "firestore" });

    const lock = await mutex.acquire("explicit-backend-key", 30);
    expect(lock).not.toBeNull();
    await lock!.release();
  });
});
