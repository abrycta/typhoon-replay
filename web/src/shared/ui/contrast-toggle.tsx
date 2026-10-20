import { Toggle } from "@abrycta/akari/react";
import { useLingui } from "@lingui/react/macro";
import { ContrastIcon } from "lucide-react";
import { useState } from "react";

import { CONTRAST_KEY, currentContrastIsMore } from "./contrast";

/**
 * High-contrast switch: sets data-contrast="more" on <html>, which Akari's tokens honour (it also follows
 * the OS setting by default). Local wrapper: Akari ships no contrast toggle yet.
 */
export function ContrastToggle() {
  const { t } = useLingui();
  const [more, setMore] = useState(currentContrastIsMore);
  return (
    <Toggle
      size="sm"
      variant="outline"
      pressed={more}
      aria-label={t`High contrast`}
      onPressedChange={(p) => {
        setMore(p);
        document.documentElement.dataset.contrast = p ? "more" : "normal";
        try {
          localStorage.setItem(CONTRAST_KEY, p ? "more" : "normal");
        } catch {
          /* storage unavailable */
        }
      }}
    >
      <ContrastIcon />
    </Toggle>
  );
}
