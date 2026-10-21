import type { HeaderCrumb } from "@abrycta/akari/react";
import { useEffect, useSyncExternalStore } from "react";

/**
 * The current page's breadcrumb, handed from the route that renders it to the Shell's Header, which mirrors it in the
 * strip once the page's own breadcrumb has scrolled away. Pages without a breadcrumb set nothing.
 */
let current: HeaderCrumb[] | undefined;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** For the Shell: the breadcrumb of the page on screen, if it has one. */
export function useHeaderCrumbs(): HeaderCrumb[] | undefined {
  return useSyncExternalStore(subscribe, () => current, () => undefined);
}

/** For a page with a breadcrumb: the same items (last = current page), cleared when the page goes. */
export function usePageCrumbs(items: HeaderCrumb[]) {
  const key = JSON.stringify(items);
  useEffect(() => {
    current = JSON.parse(key) as HeaderCrumb[];
    emit();
    return () => {
      current = undefined;
      emit();
    };
  }, [key]);
}
