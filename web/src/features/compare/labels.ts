// Small shared pieces of the compare UI (colours, duration and country words).
import { useLingui } from "@lingui/react/macro";

import type { Country } from "@/shared/model/types";

import { splitDuration } from "./align";

/** Storm A and B colours: Akari primary (藍) and the accent text colour; each passes AA as text in both themes. */
export const SLOT_COLOR = { A: "var(--ak-primary)", B: "var(--ak-text-accent)" } as const;
/** Bar and marker fills (the accent fill for B). */
export const BAR = { A: "var(--ak-primary)", B: "var(--ak-accent)" } as const;

const MINUS = "−";
/** "−12 h", "0 h", "+48 h". */
export const relLabel = (h: number) => (h === 0 ? "0 h" : `${h < 0 ? MINUS : "+"}${Math.abs(h)} h`);
export const signed = (n: number) => `${n < 0 ? MINUS : "+"}${Math.abs(n)}`;

export function useDuration() {
  const { t } = useLingui();
  return (h: number) => {
    const { days, hours } = splitDuration(h);
    return days ? t`${days} d ${hours} h` : t`${hours} h`;
  };
}

export function useCountryName() {
  const { t } = useLingui();
  return (c: Country) => (c === "PH" ? t`Philippines` : t`Japan`);
}
