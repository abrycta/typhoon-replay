// Mock mode in the browser: MSW's service worker answers /api/mock/*. Loaded lazily (ensureMock).
import { setupWorker } from "msw/browser";

import { handlers } from "./handlers";

export async function startMockWorker(): Promise<void> {
  const worker = setupWorker(...handlers);
  await worker.start({
    serviceWorker: { url: "/mockServiceWorker.js" },
    onUnhandledFrame: "bypass",
    quiet: true,
  });
}
