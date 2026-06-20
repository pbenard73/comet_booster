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
  private nLabel: Phaser.GameObjects.Text;
  private sLabel: Phaser.GameObjects.Text;

  constructor(private scene: Phaser.Scene) {
    this.g = scene.add.graphics().setScrollFactor(0).setDepth(20);
    const labelStyle = { fontFamily: 'Kenney, monospace', fontSize: '12px', color: '#dff4ff' };
    this.nLabel = scene.add.text(0, 0, 'N', labelStyle).setScrollFactor(0).setDepth(21).setOrigin(0.5);
    this.sLabel = scene.add.text(0, 0, 'S', labelStyle).setScrollFactor(0).setDepth(21).setOrigin(0.5);
  }

  draw(
    shipX: number,
    shipY: number,
    ships: Iterable<[number, Phaser.GameObjects.Image]>,
    isTeammate: (id: number) => boolean,
    isBoss: (id: number) => boolean = () => false,
  ): void {
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

    // Project an absolute world point onto the globe (torus-wrapped delta from the
    // local ship), reporting which hemisphere it lands on. Used for the fixed
    // geographic reference features (Greenwich meridian, equator, poles) and blips.
    const projWorld = (wx: number, wy: number) => {
      let dx = wx - shipX; dx = ((dx + WORLD_WIDTH  * 1.5) % WORLD_WIDTH)  - WORLD_WIDTH  / 2;
      let dy = wy - shipY; dy = ((dy + WORLD_HEIGHT * 1.5) % WORLD_HEIGHT) - WORLD_HEIGHT / 2;
      const phi = Math.min(Math.hypot(dx, dy) / GLOBE_RANGE, 1) * Math.PI;
      const r   = Math.sin(phi) * R;
      const lam = Math.atan2(dy, dx);
      return { sx: cx + Math.cos(lam) * r, sy: cy + Math.sin(lam) * r, front: Math.cos(phi) >= 0 };
    };

    // Stroke a world-space line (pre-sampled into points) onto the globe. Segments
    // whose endpoints jump too far apart (the torus seam, or a pass behind a pole)
    // are skipped so the curve never streaks across the face; back-hemisphere
    // segments are dimmed.
    const strokeWorldLine = (pts: Array<ReturnType<typeof projWorld>>, color: number, frontA: number, backA: number) => {
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i], b = pts[i + 1];
        if (Math.hypot(b.sx - a.sx, b.sy - a.sy) > R) continue;
        g.lineStyle(1.25, color, a.front && b.front ? frontA : backA);
        g.beginPath();
        g.moveTo(a.sx, a.sy);
        g.lineTo(b.sx, b.sy);
        g.strokePath();
      }
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

    // Fixed geographic reference features, projected through the same player-centric
    // mapping so they curve & slide across the globe as the ship flies. World ↔ map:
    // LON = x/W·360 (Greenwich = x 0), LAT = y/H·360 (equator = y H/2, poles ±90°).
    const SAMPLES = 64;
    const greenwich: Array<ReturnType<typeof projWorld>> = [];
    const equator:   Array<ReturnType<typeof projWorld>> = [];
    for (let i = 0; i <= SAMPLES; i++) {
      greenwich.push(projWorld(0, (i / SAMPLES) * WORLD_HEIGHT));            // meridian x=0
      equator.push(projWorld((i / SAMPLES) * WORLD_WIDTH, WORLD_HEIGHT / 2)); // parallel y=H/2
    }
    strokeWorldLine(equator,   0xffcc33, 0.55, 0.18); // equator — gold
    strokeWorldLine(greenwich, 0x33e0ff, 0.65, 0.20); // Greenwich meridian — cyan

    // Poles: points on the Greenwich meridian, ±90° latitude (a quarter-world either
    // side of the equator). Markers + N/S labels, dimmed on the back hemisphere.
    const np = projWorld(0, WORLD_HEIGHT * 0.25);
    const sp = projWorld(0, WORLD_HEIGHT * 0.75);
    g.fillStyle(0xdff4ff, 1);
    g.fillCircle(np.sx, np.sy, 1.8).fillCircle(sp.sx, sp.sy, 1.8);
    this.nLabel.setPosition(np.sx, np.sy - 8).setAlpha(np.front ? 1 : 0.4);
    this.sLabel.setPosition(sp.sx, sp.sy + 8).setAlpha(sp.front ? 1 : 0.4);

    // Blips. Back hemisphere drawn first (dim); front + teammates collected to
    // draw on top. Teammates are bright green and drawn above everyone.
    const frontBlips: Array<[number, number]> = [];
    const teamBlips:  Array<[number, number]> = [];
    const bossBlips:  Array<[number, number]> = [];   // the boss — always shown, both hemispheres
    g.fillStyle(0x6688aa, 0.40);
    for (const [id, sprite] of ships) {
      if (!sprite.visible) continue;
      const { sx, sy, front: isFront } = projWorld(sprite.x, sprite.y);
      if (isBoss(id))     bossBlips.push([sx, sy]);
      else if (isTeammate(id)) teamBlips.push([sx, sy]);
      else if (isFront)   frontBlips.push([sx, sy]);
      else                g.fillCircle(sx, sy, 1.4);
    }

    // Silhouette, then front blips, then teammates, then the boss on top.
    g.lineStyle(1.5, 0x4aa6d0, 0.6).strokeCircle(cx, cy, R);
    g.fillStyle(0xcfe8ff, 0.95);
    for (const [sx, sy] of frontBlips) g.fillCircle(sx, sy, 2.2);
    g.fillStyle(0x33ff66, 1);
    for (const [sx, sy] of teamBlips) g.fillCircle(sx, sy, 3.2);
    // Boss: a large purple blip, ringed so it stands out even on the back hemisphere.
    for (const [sx, sy] of bossBlips) {
      g.fillStyle(0x9b30ff, 1).fillCircle(sx, sy, 4.5);
      g.lineStyle(1.5, 0xd9a6ff, 0.9).strokeCircle(sx, sy, 5.5);
    }

    // Local player — fixed at the centre.
    g.fillStyle(0xff2222, 1).fillCircle(cx, cy, 3.2);
    g.fillStyle(0xffd0d0, 1).fillCircle(cx, cy, 1.3);
  }
}
