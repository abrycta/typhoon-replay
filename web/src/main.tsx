import "./index.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "@/app/App";
import { BootError } from "@/app/BootError";
import { loadConfig } from "@/shared/config/config";
import { activateLocale, initialLocale } from "@/shared/i18n/i18n";
import { applyContrastParam } from "@/shared/ui/contrast";

const root = document.getElementById("root");
if (!root) throw new Error("#root element missing from index.html");

// Web fonts: a separate stylesheet so ~600 @font-face rules never block the first paint (fallback fonts first).
void import("./fonts.css");

applyContrastParam();
const locale = initialLocale();

Promise.all([loadConfig(), activateLocale(locale)])
  .then(([config]) => {
    createRoot(root).render(
      <StrictMode>
        <App config={config} locale={locale} />
      </StrictMode>,
    );
  })
  .catch((e: unknown) => {
    createRoot(root).render(<BootError error={e} />);
  });
