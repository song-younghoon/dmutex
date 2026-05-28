import type {
  DmutexFirestoreClient,
  DmutexFirestoreCollection,
  DmutexFirestoreDocumentReference,
  DmutexFirestoreDocumentSnapshot,
  FirestoreDMutexOptions,
} from "./types";
import type { DMutexStore } from "./store";

const snapshotExists = (snapshot: DmutexFirestoreDocumentSnapshot) => {
  return typeof snapshot.exists === "function"
    ? snapshot.exists()
    : snapshot.exists;
}

const expiredAtMsFromSnapshot = (snapshot: DmutexFirestoreDocumentSnapshot) => {
  const data = snapshot.data();
  const expiredAt = data?.expiredAt;

  if (typeof expiredAt === "number") {
    return expiredAt;
  }

  if (typeof expiredAt === "string") {
    return Number(expiredAt);
  }

  if (expiredAt instanceof Date) {
    return expiredAt.getTime();
  }

  return null;
}

const tokenFromSnapshot = (snapshot: DmutexFirestoreDocumentSnapshot) => {
  const value = snapshot.data()?.value;
  return typeof value === "string" ? value : null;
}

export class FirestoreDMutexStore implements DMutexStore {
  private collection: DmutexFirestoreCollection

  constructor(serviceName: string, firestoreClient: DmutexFirestoreClient, options: FirestoreDMutexOptions) {
    this.collection = firestoreClient.collection(
      options.collectionName ?? `${options.collectionPrefix ?? "_dmutex_"}${serviceName}`,
    );
    this.firestoreClient = firestoreClient;
  }

  private firestoreClient: DmutexFirestoreClient

  public ready = async () => {}

  private ref = (key: string): DmutexFirestoreDocumentReference => {
    return this.collection.doc(encodeURIComponent(key));
  }

  public acquire = async (key: string, token: string, ttlSeconds: number) => {
    const ref = this.ref(key);

    return await this.firestoreClient.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      const now = Date.now();
      const expiredAt = new Date(now + (ttlSeconds * 1000));
      const existingExpiredAt = expiredAtMsFromSnapshot(snapshot);

      if (!snapshotExists(snapshot) || (existingExpiredAt !== null && existingExpiredAt <= now)) {
        transaction.set(ref, {
          value: token,
          expiredAt: expiredAt.getTime(),
        });
        return expiredAt;
      }

      return null;
    });
  }

  public release = async (key: string, token: string) => {
    const ref = this.ref(key);

    return await this.firestoreClient.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      if (!snapshotExists(snapshot) || tokenFromSnapshot(snapshot) !== token) {
        return false;
      }

      transaction.delete(ref);
      return true;
    });
  }

  public extend = async (key: string, token: string, ttlSeconds: number) => {
    const ref = this.ref(key);

    return await this.firestoreClient.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      const now = Date.now();
      const existingExpiredAt = expiredAtMsFromSnapshot(snapshot);

      if (
        !snapshotExists(snapshot) ||
        tokenFromSnapshot(snapshot) !== token ||
        existingExpiredAt === null ||
        existingExpiredAt <= now
      ) {
        return null;
      }

      const expiredAt = new Date(now + (ttlSeconds * 1000));
      transaction.set(ref, {
        value: token,
        expiredAt: expiredAt.getTime(),
      });

      return expiredAt;
    });
  }
}
