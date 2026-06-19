// Torus (wrap-around world) coordinate helpers.

/** Wrap a value into [0, max). */
export const wrap = (v: number, max: number): number => ((v % max) + max) % max;

/**
 * Map a world coord `wx` to the torus image nearest the centre `cx`, in the
 * local ship's continuous (un-wrapped) frame. Keeps neighbours adjacent across
 * the world seam, so distance checks downstream are torus-correct for free.
 */
export const nearestImage = (wx: number, cx: number, world: number): number => {
  const d = wx - cx;
  return cx + d - world * Math.round(d / world);
};
