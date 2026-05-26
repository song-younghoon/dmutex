export type DMutexStore = {
  ready(): Promise<void>
  acquire(key: string, token: string, ttlSeconds: number): Promise<Date | null>
  release(key: string, token: string): Promise<boolean>
  extend(key: string, token: string, ttlSeconds: number): Promise<boolean>
}
