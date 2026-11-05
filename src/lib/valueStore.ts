import { useSyncExternalStore } from "react";

/** A value that changes too often to live in React state at the top of a big
 *  tree (the grid canvas's pan/zoom changes every frame): writers set it
 *  directly, and only the small components that read it re-render. */
export interface ValueStore<T> {
  get: () => T;
  set: (next: T) => void;
  subscribe: (fn: () => void) => () => void;
}

export function createValueStore<T>(initial: T): ValueStore<T> {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set: (next) => {
      if (Object.is(next, value)) return;
      value = next;
      for (const fn of listeners) fn();
    },
    subscribe: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

export function useStoreValue<T>(store: ValueStore<T>): T {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}
