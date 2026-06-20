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
 * The neighbour walk is **torus-aware**: the (2·range+1)² window wraps across the
 * world seam, so a viewer parked at an edge (e.g. a pole refuge at x=0) still sees
 * ships just past the wrap at the full tick rate instead of only via the 2 Hz
 * `minimap_update`. Callers must still apply a torus-shortest distance test —
 * wrapping only fixes which buckets are visited, not the metric.
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

  /** Visit every player in the (2·range+1)² block of cells around (x, y), with the
   *  window wrapping across the world seam (torus-aware). When an axis spans only
   *  ≤ 2·range+1 cells, every cell on it is walked once (wrapping would otherwise
   *  revisit the same bucket and double-count). */
  forEachNear(x: number, y: number, range: number, cb: (p: ServerPlayer) => void): void {
    const cols = this.cols, rows = this.rows;
    const cx = Math.floor(x / GRID_CELL);
    const cy = Math.floor(y / GRID_CELL);
    const fullX = cols <= 2 * range + 1;
    const fullY = rows <= 2 * range + 1;
    for (let oy = fullY ? 0 : -range; oy <= (fullY ? rows - 1 : range); oy++) {
      const gy = fullY ? oy : (((cy + oy) % rows) + rows) % rows;
      for (let ox = fullX ? 0 : -range; ox <= (fullX ? cols - 1 : range); ox++) {
        const gx = fullX ? ox : (((cx + ox) % cols) + cols) % cols;
        const cell = this.cells.get(gy * cols + gx);
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
