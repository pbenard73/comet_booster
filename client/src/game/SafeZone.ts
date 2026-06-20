import Phaser from 'phaser';
import { WORLD_WIDTH, WORLD_HEIGHT, SAFE_ZONES, SAFE_ZONE_RADIUS } from '@shared/constants';
import { nearestImage } from './torus';

/**
 * The pole "refuge" safe zones, drawn as animated sci-fi force-field domes.
 *
 * Each zone is a fixed world location (a geographic pole), so it's rendered at
 * the torus image nearest the local ship — exactly like remote ships — and
 * redrawn every frame into a single Graphics (only two circles + a ring of
 * dashes, so the cost is negligible). Sits below ships (depth 1) so ships
 * sheltering inside render on top, with a faint floating "REFUGE" label.
 */
export class SafeZone {
  private g: Phaser.GameObjects.Graphics;
  private labels: Phaser.GameObjects.Text[];

  constructor(scene: Phaser.Scene) {
    this.g = scene.add.graphics().setDepth(1);
    this.labels = SAFE_ZONES.map(() =>
      scene.add.text(0, 0, '⛨ REFUGE', {
        fontSize: '20px', color: '#9ff4ff', fontFamily: 'Kenney, monospace',
        stroke: '#003344', strokeThickness: 4,
      }).setOrigin(0.5).setDepth(1).setAlpha(0.5),
    );
  }

  /** Redraw each zone at the torus image nearest the local ship. */
  draw(shipX: number, shipY: number, time: number): void {
    const g = this.g;
    g.clear();
    const t = time / 1000;
    const R = SAFE_ZONE_RADIUS;

    SAFE_ZONES.forEach((z, i) => {
      const cx = nearestImage(z.x, shipX, WORLD_WIDTH);
      const cy = nearestImage(z.y, shipY, WORLD_HEIGHT);

      // Soft energy fill — two stacked translucent discs with a slow breath.
      const breath = (Math.sin(t * 1.5) + 1) / 2;
      g.fillStyle(0x1199ff, 0.06).fillCircle(cx, cy, R);
      g.fillStyle(0x33ddff, 0.05).fillCircle(cx, cy, R * 0.78);

      // Rotating dashed containment ring — the "force field".
      g.lineStyle(4, 0x66f0ff, 0.85);
      const dashes = 32;
      for (let d = 0; d < dashes; d++) {
        const a0 = t * 0.4 + (d / dashes) * Math.PI * 2;
        const a1 = a0 + ((Math.PI * 2) / dashes) * 0.55;
        g.beginPath();
        g.arc(cx, cy, R, a0, a1);
        g.strokePath();
      }

      // Steady inner edge + a pulsing energy ripple sweeping inward.
      g.lineStyle(1.5, 0x99f8ff, 0.4).strokeCircle(cx, cy, R - 6);
      g.lineStyle(2, 0xaaffff, 0.15 + 0.25 * breath).strokeCircle(cx, cy, R - 14 - breath * 8);

      const label = this.labels[i];
      label.setPosition(cx, cy).setAlpha(0.35 + 0.2 * breath);
    });
  }
}
