import { AkariProvider } from "@abrycta/akari/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { useState } from "react";

import type { AppConfig } from "@/shared/config/config";
import { ConfigContext } from "@/shared/config/context";
import { LinguiBridge } from "@/shared/i18n/bridge";
import type { Locale } from "@/shared/i18n/i18n";

import { createAppRouter } from "./router";

/** Theme and contrast are shared with every *.krtmtthw.dev app (index.html loads the matching theme-init.js). */
export const THEME_COOKIE_DOMAIN = "krtmtthw.dev";

export function App({ config, locale }: { config: AppConfig; locale: Locale }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { refetchOnWindowFocus: false } },
      }),
  );
  const [router] = useState(() => createAppRouter(queryClient));
  return (
    <ConfigContext.Provider value={config}>
      <QueryClientProvider client={queryClient}>
        <AkariProvider
          defaultLang={locale}
          toaster={false}
          sharedCookieDomain={THEME_COOKIE_DOMAIN}
          inlineScript={false}
        >
          <LinguiBridge>
            <RouterProvider router={router} />
          </LinguiBridge>
        </AkariProvider>
      </QueryClientProvider>
    </ConfigContext.Provider>
  );
}
