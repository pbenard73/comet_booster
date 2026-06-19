import Phaser from 'phaser';
import { WORLD_WIDTH, WORLD_HEIGHT, BONUS_SIZE_PX } from '@shared/constants';
import type { BonusState, BonusType } from '@shared/types';
import { nearestImage } from './torus';

interface BonusItem {
  kind:   BonusType;
  world:  { x: number; y: number };   // authoritative server position
  sprite: Phaser.GameObjects.Image;
}

/**
 * Owns every world bonus pickup: its sprite, server position, and a continuous
 * bob ("bounce") animation. Like RemoteShips, each frame the sprites are placed
 * at the torus image nearest the local ship so the seam is invisible, and a
 * vertical sine bob is applied on top (computed from the clock so it survives the
 * per-frame re-position — a y-tween would be clobbered by it).
 */
export class BonusSystem {
  private items = new Map<number, BonusItem>();

  constructor(private scene: Phaser.Scene) {}

  get size(): number { return this.items.size; }
  has(id: number): boolean { return this.items.has(id); }
  kindOf(id: number): BonusType | undefined { return this.items.get(id)?.kind; }

  spawn(bonus: BonusState): void {
    if (this.items.has(bonus.id)) return;
    const sprite = this.scene.add.image(bonus.x, bonus.y, `bonus_${bonus.kind}`)
      .setDisplaySize(BONUS_SIZE_PX, BONUS_SIZE_PX)
      .setDepth(4);
    this.items.set(bonus.id, { kind: bonus.kind, world: { x: bonus.x, y: bonus.y }, sprite });
  }

  remove(id: number): void {
    const item = this.items.get(id);
    if (!item) return;
    // A quick pop on pickup, then destroy.
    this.scene.tweens.add({
      targets: item.sprite, scaleX: 0, scaleY: 0, alpha: 0,
      duration: 160, ease: 'Back.easeIn',
      onComplete: () => item.sprite.destroy(),
    });
    this.items.delete(id);
  }

  clearAll(): void {
    for (const { sprite } of this.items.values()) sprite.destroy();
    this.items.clear();
  }

  /** Place every bonus at its torus image nearest the local ship, with a bob. */
  reposition(shipX: number, shipY: number): void {
    const t = this.scene.time.now / 1000;
    for (const { world, sprite } of this.items.values()) {
      const x = nearestImage(world.x, shipX, WORLD_WIDTH);
      const y = nearestImage(world.y, shipY, WORLD_HEIGHT);
      sprite.setPosition(x, y - 8 * Math.abs(Math.sin(t * 3)));
    }
  }

  /** Return the id of the first bonus overlapping the ship (within `radius`), or null. */
  firstOverlapping(shipX: number, shipY: number, radius: number): number | null {
    const rSq = radius * radius;
    for (const [id, { sprite }] of this.items) {
      const dx = sprite.x - shipX, dy = sprite.y - shipY;
      if (dx * dx + dy * dy <= rSq) return id;
    }
    return null;
  }
}
