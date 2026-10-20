import { createContext, useContext } from "react";

import type { AppConfig } from "./config";

export const ConfigContext = createContext<AppConfig | null>(null);

export function useAppConfig(): AppConfig {
  const cfg = useContext(ConfigContext);
  if (!cfg) throw new Error("useAppConfig outside <ConfigContext.Provider>");
  return cfg;
}
