// Entry of the frozen embed (embed/storm/<sid>.html): same build, chunks and providers as the app, but no router,
// no Header and no runtime config. Every byte comes from this origin: the packed file and the baked basemap.
import "../index.css";
import "./embed.css";

import { AkariProvider } from "@abrycta/akari/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { BootError } from "@/app/BootError";
import type { ResolvedDataset } from "@/data";
import { type AppConfig } from "@/shared/config/config";
import { ConfigContext } from "@/shared/config/context";
import { LinguiBridge } from "@/shared/i18n/bridge";
import { activateLocale, initialLocale } from "@/shared/i18n/i18n";
import { applyContrastParam } from "@/shared/ui/contrast";

import { EmbedReplay } from "./EmbedReplay";
import { EMBED } from "./haiyan.generated";
import { loadPack } from "./pack";
import { listenToParent } from "./parent-bridge";

const root = document.getElementById("root");
if (!root) throw new Error("#root element missing");

void import("../fonts.css");
applyContrastParam();
listenToParent();
const locale = initialLocale();

// The replay reads the track through the data hooks: seed their cache so they never fetch.
const BASE = "/embed-data/";
const config: AppConfig = {
  siteUrl: "https://replay.krtmtthw.dev",
  data: { baseUrl: BASE, pointer: "-", fallbackBaseUrls: [] },
  backends: [{ id: "java", label: "Java", baseUrl: "/api/java" }],
  defaultBackend: "java",
};
const dataset: ResolvedDataset = { root: BASE, baseUrl: BASE, version: 0, source: "primary" };

Promise.all([loadPack(), activateLocale(locale)])
  .then(([data]) => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false, refetchOnWindowFocus: false } } });
    queryClient.setQueryData(["dataset", BASE], dataset);
    queryClient.setQueryData(["track", BASE, EMBED.sid], data.track);
    createRoot(root).render(
      <StrictMode>
        <ConfigContext.Provider value={config}>
          <QueryClientProvider client={queryClient}>
            <AkariProvider defaultLang={locale} toaster={false} sharedCookieDomain="krtmtthw.dev" inlineScript={false}>
              <LinguiBridge>
                <EmbedReplay data={data} dataset={dataset} />
              </LinguiBridge>
            </AkariProvider>
          </QueryClientProvider>
        </ConfigContext.Provider>
      </StrictMode>,
    );
  })
  .catch((e: unknown) => createRoot(root).render(<BootError error={e} />));
