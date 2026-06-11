/**
 * Tiny typed pub/sub used internally by every controller. Avoids pulling
 * in `events` / `eventemitter3` and keeps the bundle dependency-free.
 */
export type Listener = () => void;

export function createStore<T>(initial: T) {
  let value = initial;
  const listeners = new Set<Listener>();
  return {
    get(): T {
      return value;
    },
    set(next: T): void {
      if (Object.is(next, value)) return;
      value = next;
      listeners.forEach((fn) => {
        try { fn(); } catch { /* listener errors must not block others */ }
      });
    },
    subscribe(fn: Listener): () => void {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
    _emit(): void {
      listeners.forEach((fn) => {
        try { fn(); } catch { /* noop */ }
      });
    },
  };
}

export type Store<T> = ReturnType<typeof createStore<T>>;
