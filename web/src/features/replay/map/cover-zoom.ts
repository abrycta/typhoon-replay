/** `view`'s zoom for a w×h map when the view was framed for `frame` (covers the same area: no empty edges). */
export function coverZoom(zoom: number, frame: readonly [number, number], w: number, h: number): number {
  if (!(w > 0 && h > 0)) return zoom;
  return zoom + Math.log2(Math.max(w / frame[0], h / frame[1]));
}
