import { useLingui } from "@lingui/react/macro";

/**
 * Why a race lane failed, in the reader's language.
 *
 * `lane.reason` is English from three places: the wake loop's own words (wake.ts), the problem `title`
 * a backend or the edge sent (RFC 9457, the contract's fixed titles), or a browser network error message.
 * English notes show it as is. Other languages get a translated phrase for each known reason, and a
 * phrase for its kind (network, timeout, server or request error) for free text the page cannot know
 * in advance (an unexpected title, a browser's error message), so no English lands inside a Japanese note.
 */
export function useReasonText(): (reason: string | undefined, httpStatus?: number) => string {
  const { t, i18n } = useLingui();
  const known: Record<string, string> = {
    // wake.ts
    "did not wake up in time": t`did not wake up in time`,
    "not deployed": t`not deployed`,
    "paused this month": t`paused this month`,
    "rate limited": t`rate limited`,
    // request.ts
    "network error": t`network error`,
    "invalid json": t`invalid JSON`,
    // Problem titles (contract, edge/src/http.ts)
    "request validation failed": t`request validation failed`,
    "invalid cursor": t`invalid cursor`,
    "not found": t`not found`,
    "unknown backend": t`unknown backend`,
    "method not allowed": t`method not allowed`,
    "not acceptable": t`not acceptable`,
    "payload too large": t`payload too large`,
    "unsupported media type": t`unsupported media type`,
    "too many requests": t`too many requests`,
    "internal server error": t`internal server error`,
    "service not ready": t`service not ready`,
    "too many live streams": t`too many live streams`,
    "backend not deployed": t`backend not deployed`,
    "backend is waking up": t`backend is waking up`,
    "backend unavailable": t`backend unavailable`,
    "backend paused this month": t`backend paused this month`,
    "bad gateway": t`bad gateway`,
    "gateway timeout": t`gateway timeout`,
    "api in static mode": t`API in static mode`,
  };
  return (reason, httpStatus) => {
    if (!reason) return "?";
    if (i18n.locale === "en") return reason;
    const hit = known[reason.trim().toLowerCase()] ?? (/^http \d{3}$/i.test(reason.trim()) ? reason.trim() : undefined);
    if (hit) return hit;
    if (!httpStatus) return /time(d)? ?out|aborted/i.test(reason) ? t`timed out` : t`network error`;
    return httpStatus >= 500 ? t`server error` : t`request error`;
  };
}
