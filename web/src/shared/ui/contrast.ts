export const CONTRAST_KEY = "contrast";

/** Before first render: apply ?contrast= or the saved choice as data-contrast on <html>. */
export function applySavedContrast() {
  try {
    const url = new URLSearchParams(location.search).get("contrast");
    const v = url === "more" || url === "normal" ? url : localStorage.getItem(CONTRAST_KEY);
    if (v === "more" || v === "normal") document.documentElement.dataset.contrast = v;
  } catch {
    /* storage unavailable */
  }
}

export function currentContrastIsMore(): boolean {
  if (typeof document === "undefined") return false;
  const v = document.documentElement.dataset.contrast;
  if (v === "more") return true;
  if (v === "normal") return false;
  return typeof matchMedia !== "undefined" && matchMedia("(prefers-contrast: more)").matches;
}
