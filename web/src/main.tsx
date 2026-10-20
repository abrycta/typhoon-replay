import "./index.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { initBackends } from "@/api";
import { App } from "@/app/App";
import { BootError } from "@/app/BootError";
import { loadConfig } from "@/shared/config/config";
import { activateLocale, initialLocale } from "@/shared/i18n/i18n";
import { applySavedContrast } from "@/shared/ui/contrast";

const root = document.getElementById("root");
if (!root) throw new Error("#root element missing from index.html");

applySavedContrast();
const locale = initialLocale();

Promise.all([loadConfig(), activateLocale(locale)])
  .then(([config]) => {
    initBackends(config.backends, config.defaultBackend, new URLSearchParams(location.search).get("backend") ?? undefined);
    createRoot(root).render(
      <StrictMode>
        <App config={config} locale={locale} />
      </StrictMode>,
    );
  })
  .catch((e: unknown) => {
    createRoot(root).render(<BootError error={e} />);
  });
