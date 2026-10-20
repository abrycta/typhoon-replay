import { useLang } from "@abrycta/akari/react";
import { I18nProvider } from "@lingui/react";
import { type ReactNode, useEffect, useState } from "react";

import { activateLocale, i18n } from "./i18n";

/** Lingui follows Akari's language (EN / 日本語 switch, <html lang>, persistence). */
export function LinguiBridge({ children }: { children: ReactNode }) {
  const { lang } = useLang();
  const [, force] = useState(0);
  useEffect(() => {
    void activateLocale(lang).then(() => force((n) => n + 1));
  }, [lang]);
  return <I18nProvider i18n={i18n}>{children}</I18nProvider>;
}
