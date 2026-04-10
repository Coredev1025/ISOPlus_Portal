const pending = new Map<string, Promise<unknown>>();

export function dedupeByKey<T>(key: string, factory: () => Promise<T>): Promise<T> {
  const existing = pending.get(key);
  if (existing) return existing as Promise<T>;

  const p = factory().finally(() => {
    pending.delete(key);
  });
  pending.set(key, p);
  return p as Promise<T>;
}
