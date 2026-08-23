/**
 * Boundary declaration for `@plannotator/ui/utils/storage` (0.30.0,
 * utils/storage.ts:12-57). The default backend reads and writes
 * `document.cookie`; the review frame installs an in-memory backend so the
 * viewer keeps the application's zero-web-storage posture.
 */
export interface StorageBackend {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
}

export declare function setStorageBackend(backend: StorageBackend): void;
