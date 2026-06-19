import Phaser from 'phaser';
import { WORLD_WIDTH, WORLD_HEIGHT, MAP_SIZE, MAP_PAD } from '@shared/constants';

// Farthest reachable (torus-wrapped) distance maps to the far pole.
const GLOBE_RANGE = Math.hypot(WORLD_WIDTH / 2, WORLD_HEIGHT / 2);

/**
 * Fake-3D radar sphere drawn with a single screen-space Graphics — no second
 * camera. The local player is the fixed red dot at the centre (the pole facing
 * the viewer); every other ship is placed by its torus-wrapped bearing & distance,
 * so nearby ships sit near the centre and the antipode wraps to the far pole.
 * Ships on the back hemisphere render small and dim. The sphere does **not**
 * spin — north stays up (a ship due north sits at the top of the globe).
 */
export class Radar {
  private g: Phaser.GameObjects.Graphics;

  constructor(private scene: Phaser.Scene) {
    this.g = scene.add.graphics().setScrollFactor(0).setDepth(20);
  }

  draw(shipX: number, shipY: number, sprites: Iterable<Phaser.GameObjects.Image>): void {
    const R  = MAP_SIZE / 2;
    const cx = this.scene.scale.width  - R - MAP_PAD;
    const cy = this.scene.scale.height - R - MAP_PAD;

    const g = this.g;
    g.clear();

    // Fake-lit sphere body: stacked translucent discs offset toward the upper-left.
    g.fillStyle(0x020912, 0.55).fillCircle(cx, cy, R);
    g.fillStyle(0x0b3a5c, 0.45).fillCircle(cx - R * 0.28, cy - R * 0.30, R * 0.78);
    g.fillStyle(0x18608f, 0.40).fillCircle(cx - R * 0.42, cy - R * 0.44, R * 0.45);
    g.fillStyle(0x9fe8ff, 0.18).fillCircle(cx - R * 0.50, cy - R * 0.52, R * 0.18);

    // Latitude rings — concentric circles read as a pole-on sphere.
    g.lineStyle(1, 0x2f7da6, 0.22);
    for (const f of [0.5, 0.8, 0.97]) g.strokeCircle(cx, cy, R * f);

    // Meridian spokes (static — north is up, the globe no longer spins).
    g.lineStyle(1, 0x2f7da6, 0.20);
    for (let m = 0; m < 6; m++) {
      const a = (m / 6) * Math.PI;
      g.beginPath();
      g.moveTo(cx - Math.cos(a) * R, cy - Math.sin(a) * R);
      g.lineTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R);
      g.strokePath();
    }

    // Project a world delta (dx, dy) from the local ship onto the globe — same
    // mapping as the blips below.
    const project = (dx: number, dy: number): [number, number] => {
      const phi = Math.min(Math.hypot(dx, dy) / GLOBE_RANGE, 1) * Math.PI;
      const r   = Math.sin(phi) * R;
      const lam = Math.atan2(dy, dx);
      return [cx + Math.cos(lam) * r, cy + Math.sin(lam) * r];
    };

    // Visible viewport outline — the camera shows scale.width × scale.height of
    // world centred on the ship (1× zoom). Sample along each edge so the rectangle
    // curves with the sphere instead of cutting straight across it.
    const hw = this.scene.scale.width  / 2;
    const hh = this.scene.scale.height / 2;
    const corners: Array<[number, number]> = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]];
    const SEG = 8;
    g.lineStyle(1, 0x9fe8ff, 0.35);
    g.beginPath();
    for (let i = 0; i < 4; i++) {
      const [ax, ay] = corners[i];
      const [bx, by] = corners[(i + 1) % 4];
      for (let s = 0; s <= SEG; s++) {
        const t = s / SEG;
        const [sx, sy] = project(ax + (bx - ax) * t, ay + (by - ay) * t);
        if (i === 0 && s === 0) g.moveTo(sx, sy);
        else g.lineTo(sx, sy);
      }
    }
    g.closePath();
    g.strokePath();

    // Blips. Back hemisphere drawn first (dim), front collected to draw on top.
    const front: Array<[number, number]> = [];
    g.fillStyle(0x6688aa, 0.40);
    for (const sprite of sprites) {
      if (!sprite.visible) continue;
      let dx = sprite.x - shipX; dx = ((dx + WORLD_WIDTH  * 1.5) % WORLD_WIDTH)  - WORLD_WIDTH  / 2;
      let dy = sprite.y - shipY; dy = ((dy + WORLD_HEIGHT * 1.5) % WORLD_HEIGHT) - WORLD_HEIGHT / 2;
      const phi = Math.min(Math.hypot(dx, dy) / GLOBE_RANGE, 1) * Math.PI;
      const r   = Math.sin(phi) * R;
      const lam = Math.atan2(dy, dx);
      const sx  = cx + Math.cos(lam) * r;
      const sy  = cy + Math.sin(lam) * r;
      if (Math.cos(phi) >= 0) front.push([sx, sy]);
      else g.fillCircle(sx, sy, 1.4);
    }

    // Silhouette, then front blips on top of the wireframe.
    g.lineStyle(1.5, 0x4aa6d0, 0.6).strokeCircle(cx, cy, R);
    g.fillStyle(0xcfe8ff, 0.95);
    for (const [sx, sy] of front) g.fillCircle(sx, sy, 2.2);

    // Local player — fixed at the centre.
    g.fillStyle(0xff2222, 1).fillCircle(cx, cy, 3.2);
    g.fillStyle(0xffd0d0, 1).fillCircle(cx, cy, 1.3);
  }
}
