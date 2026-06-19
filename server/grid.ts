import { WORLD_WIDTH, WORLD_HEIGHT, GRID_CELL } from '../shared/constants.js';
import type { ServerPlayer } from './score.js';

/**
 * Uniform spatial hash over the world, rebuilt once per server tick. Turns the
 * per-tick neighbour search from O(N²) (scan every socket against every player)
 * into O(N + Σ neighbours): bucket all live players into fixed cells, then for
 * each viewer only walk the (2·range+1)² cells around it.
 *
 * The cell size is ≥ AOI_RADIUS, so every ship within the area-of-interest of a
 * point sits in that point's own cell or one of the 8 around it (`range = 1`).
 * Like the rest of the server's AoI maths this is **not** torus-aware — positions
 * are already wrapped into [0, WORLD), and seam/distant ships are kept fresh by
 * the 2 Hz `minimap_update` (which has no AoI filter).
 */
export class SpatialGrid {
  private readonly cols = Math.ceil(WORLD_WIDTH  / GRID_CELL);
  private readonly rows = Math.ceil(WORLD_HEIGHT / GRID_CELL);
  private readonly cells = new Map<number, ServerPlayer[]>();

  /** Drop the old buckets and re-insert every live player. */
  rebuild(players: Iterable<ServerPlayer>): void {
    this.cells.clear();
    for (const p of players) {
      if (p.dead) continue;
      const key = this.keyAt(p.x, p.y);
      const cell = this.cells.get(key);
      if (cell) cell.push(p);
      else this.cells.set(key, [p]);
    }
  }

  /** Visit every player in the (2·range+1)² block of cells around (x, y). */
  forEachNear(x: number, y: number, range: number, cb: (p: ServerPlayer) => void): void {
    const cx = Math.floor(x / GRID_CELL);
    const cy = Math.floor(y / GRID_CELL);
    const gx0 = Math.max(0, cx - range), gx1 = Math.min(this.cols - 1, cx + range);
    const gy0 = Math.max(0, cy - range), gy1 = Math.min(this.rows - 1, cy + range);
    for (let gy = gy0; gy <= gy1; gy++) {
      for (let gx = gx0; gx <= gx1; gx++) {
        const cell = this.cells.get(gy * this.cols + gx);
        if (cell) for (const p of cell) cb(p);
      }
    }
  }

  private keyAt(x: number, y: number): number {
    const cx = Math.min(this.cols - 1, Math.max(0, Math.floor(x / GRID_CELL)));
    const cy = Math.min(this.rows - 1, Math.max(0, Math.floor(y / GRID_CELL)));
    return cy * this.cols + cx;
  }
}
