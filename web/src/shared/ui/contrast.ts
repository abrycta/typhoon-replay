/**
 * Before first render: a ?contrast=more|normal link overrides for this page view (not stored). The saved
 * choice is applied earlier by Akari's theme-init.js (shared krtmtthw.dev cookie, or localStorage).
 */
export function applyContrastParam() {
  const url = new URLSearchParams(location.search).get("contrast");
  if (url === "more" || url === "normal")
    document.documentElement.dataset.contrast = url;
}

export function currentContrastIsMore(): boolean {
  if (typeof document === "undefined") return false;
  const v = document.documentElement.dataset.contrast;
  if (v === "more") return true;
  if (v === "normal") return false;
  return (
    typeof matchMedia !== "undefined" &&
    matchMedia("(prefers-contrast: more)").matches
  );
}
