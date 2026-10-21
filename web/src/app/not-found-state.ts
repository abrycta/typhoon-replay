import { useSyncExternalStore } from "react";

// Whether a NotFound page is showing (router-level or inside a route, e.g. an unknown storm id): the Header then marks nothing.
let notFoundCount = 0;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

/** True while a NotFound page is on screen. */
export function useIsNotFound(): boolean {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => notFoundCount > 0,
    () => false,
  );
}

/** Called by NotFound on mount; returns the cleanup for unmount. */
export function markNotFound(): () => void {
  notFoundCount++;
  emit();
  return () => {
    notFoundCount--;
    emit();
  };
}
