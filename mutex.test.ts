import { test, expect, beforeAll, afterAll, describe } from "bun:test";
import { MongoClient } from "mongodb";
import { Mutex, type DmutexMongoCollectionDocument } from "./mutex";

describe("Mutex", () => {
  let mongoClient: MongoClient;
  let mutex: Mutex;

  beforeAll(async () => {
    const url = process.env.MONGODB_URL || "mongodb://localhost:27017";
    mongoClient = new MongoClient(url);
    await mongoClient.connect();

    mutex = new Mutex("test-service", mongoClient);
  });

  afterAll(async () => {
    const db = mongoClient.db('dmutex');
    await db.collection('_dmutex_test-service').drop().catch(() => {});
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
    const db = mongoClient.db('dmutex');
    const collection = db.collection<DmutexMongoCollectionDocument>('_dmutex_test-service');
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
});
