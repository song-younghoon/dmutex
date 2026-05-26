import { test, expect, beforeAll, afterAll, describe } from "bun:test";
import { MongoClient } from "mongodb";
import { Mutex, type DmutexMongoCollectionDocument } from "./mutex";

describe("Mutex", () => {
  let mongoClient: MongoClient | undefined;
  let mutex: Mutex;
  const collectionName = `_dmutex_test-service_${process.pid}`;

  beforeAll(async () => {
    const url = process.env.MONGODB_URL || "mongodb://localhost:27017";
    mongoClient = new MongoClient(url, { serverSelectionTimeoutMS: 1000 });
    try {
      await mongoClient.connect();
    } catch (error) {
      throw new Error(
        `MongoDB is required for integration tests. Start MongoDB or set MONGODB_URL. Tried: ${url}`,
        { cause: error },
      );
    }

    mutex = new Mutex("test-service", mongoClient, { collectionName });
    await mutex.ready();
  });

  afterAll(async () => {
    if (!mongoClient) {
      return;
    }

    const db = mongoClient.db('dmutex');
    await db.collection(collectionName).drop().catch(() => {});
    await mongoClient.close();
  });

  test("should acquire lock successfully", async () => {
    const result = await mutex.lock("test-key-1");
    expect(result).toBe(true);

    // Cleanup
    await mutex.unlock("test-key-1");
  });

  test("should fail to acquire lock when already locked", async () => {
    const key = "test-key-2";

    // First lock should succeed
    const firstLock = await mutex.lock(key);
    expect(firstLock).toBe(true);

    // Second lock should fail
    const secondLock = await mutex.lock(key);
    expect(secondLock).toBe(false);

    // Cleanup
    await mutex.unlock(key);
  });

  test("should allow lock after unlock", async () => {
    const key = "test-key-3";

    // Acquire lock
    await mutex.lock(key);

    // Release lock
    await mutex.unlock(key);

    // Should be able to acquire again
    const result = await mutex.lock(key);
    expect(result).toBe(true);

    // Cleanup
    await mutex.unlock(key);
  });

  test("should set expiredAt field correctly", async () => {
    const key = "test-key-4";

    // Acquire lock with 5 second TTL
    const result = await mutex.lock(key, 5);
    expect(result).toBe(true);

    // Check if the document has the correct expiredAt field
    const db = mongoClient!.db('dmutex');
    const collection = db.collection<DmutexMongoCollectionDocument>(collectionName);
    const doc = await collection.findOne({ _id: key });

    expect(doc).not.toBeNull();
    expect(doc?.expiredAt).toBeInstanceOf(Date);

    // Check that expiredAt is approximately 5 seconds in the future
    const now = Date.now();
    const expiredAtTime = doc!.expiredAt.getTime();
    const diff = expiredAtTime - now;

    // Should be between 4 and 6 seconds (allowing for execution time)
    expect(diff).toBeGreaterThan(4000);
    expect(diff).toBeLessThan(6000);

    // Cleanup
    await mutex.unlock(key);
  });

  test("should handle concurrent lock attempts", async () => {
    const key = "test-key-5";

    // Attempt to acquire lock from multiple "clients" simultaneously
    const results = await Promise.all([
      mutex.lock(key),
      mutex.lock(key),
      mutex.lock(key),
    ]);

    // Only one should succeed
    const successCount = results.filter(r => r === true).length;
    expect(successCount).toBe(1);

    // Cleanup
    await mutex.unlock(key);
  });

  test("should not release a lock owned by another token", async () => {
    const key = "test-key-token";
    const firstLock = await mutex.acquire(key, 30);
    expect(firstLock).not.toBeNull();

    const secondMutex = new Mutex("test-service", mongoClient!, { collectionName });
    const releasedBySecondMutex = await secondMutex.unlock(key, "wrong-token");
    expect(releasedBySecondMutex).toBe(false);

    const secondLockAttempt = await secondMutex.acquire(key, 30);
    expect(secondLockAttempt).toBeNull();

    // Cleanup
    await firstLock!.release();
  });

  test("should allow takeover of expired lock without waiting for TTL cleanup", async () => {
    const key = "test-key-expired-takeover";
    const firstLock = await mutex.acquire(key, 30);
    expect(firstLock).not.toBeNull();

    const db = mongoClient!.db('dmutex');
    const collection = db.collection<DmutexMongoCollectionDocument>(collectionName);
    await collection.updateOne(
      { _id: key },
      { $set: { expiredAt: new Date(Date.now() - 1000) } },
    );

    const secondLock = await mutex.acquire(key, 30);
    expect(secondLock).not.toBeNull();
    expect(secondLock!.token).not.toBe(firstLock!.token);

    const staleRelease = await firstLock!.release();
    expect(staleRelease).toBe(false);

    const doc = await collection.findOne({ _id: key });
    expect(doc?.value).toBe(secondLock!.token);

    // Cleanup
    await secondLock!.release();
  });

  test("should extend only an active owned lock", async () => {
    const key = "test-key-extend";
    const lock = await mutex.acquire(key, 5);
    expect(lock).not.toBeNull();

    const extended = await lock!.extend(30);
    expect(extended).toBe(true);

    const invalidOwnerExtended = await mutex.extend(key, "wrong-token", 30);
    expect(invalidOwnerExtended).toBe(false);

    // Cleanup
    await lock!.release();
  });

  test("should reject invalid ttl values", async () => {
    await expect(mutex.lock("test-key-invalid-ttl", 0)).rejects.toThrow(RangeError);
    await expect(mutex.acquire("test-key-invalid-ttl", -1)).rejects.toThrow(RangeError);
  });
});
