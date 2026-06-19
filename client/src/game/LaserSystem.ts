import Phaser from 'phaser';
import {
  LASER_SPEED, LASER_COOLDOWN_MS, LASER_BASE_RANGE, LASER_RANGE_STEP,
  LASER_CONE_LEVEL, LASER_CONE_STEP_DEG, LASER_WING_SPACING,
  LASER_BASE_CHARGES, LASER_CHARGE_REGEN_MS, LASER_CHARGES_PER_5LV,
  LASER_HIT_FRACTION, BOT_SHOOT_DAMAGE, BONUS_MEGA_COOLDOWN_MS,
} from '@shared/constants';
import { shipScaleForLevel } from './scale';
import { showLaserHit } from './effects';
import type { RemoteShips } from './RemoteShips';

interface Bolt {
  image: Phaser.GameObjects.Image;
  vx: number; vy: number;
  range: number; traveled: number;
  remote?: true;
  shooterId?: number;
}

/** What the laser system needs from the scene to resolve fire & damage. */
export interface LaserDeps {
  ship: () => Phaser.Physics.Arcade.Image;
  level: () => number;
  isDead: () => boolean;
  invincibleUntil: () => number;
  remoteShips: RemoteShips;
  onHitRemote: (id: number) => void;                          // landed our bolt on a ship
  hitSelf: (amount: number, shooterId: number | null) => void; // an incoming bolt reached us
}

export class LaserSystem {
  private bolts: Bolt[] = [];
  private cooldownUntil = 0;

  // Fire-power gauge: `charges` is a float that regenerates over time; firing
  // costs one whole charge and is blocked when the gauge is empty.
  private charges = LASER_BASE_CHARGES;
  private prevMax = LASER_BASE_CHARGES;

  // Mega-weapon bonus: until this time, fire on a short cooldown and consume no
  // charges (unlimited burst).
  private megaUntil = 0;

  constructor(private scene: Phaser.Scene, private deps: LaserDeps) {
    this.buildTexture();
  }

  /** Activate the mega-weapon (unlimited rapid fire) for `ms`. */
  activateMega(ms: number): void { this.megaUntil = this.scene.time.now + ms; }
  deactivateMega(): void { this.megaUntil = 0; }
  isMega(): boolean { return this.scene.time.now < this.megaUntil; }
  megaRemainingMs(): number { return Math.max(0, this.megaUntil - this.scene.time.now); }

  /** Max charges for the current level — one extra every 5 levels. */
  maxCharges(): number {
    return LASER_BASE_CHARGES + Math.floor(this.deps.level() / 5) * LASER_CHARGES_PER_5LV;
  }

  getCharges(): number { return this.charges; }

  /** Top the gauge back up to full (e.g. on respawn). */
  refill(): void { this.charges = this.maxCharges(); }

  private buildTexture(): void {
    const W = 6, H = 28;
    const g = this.scene.make.graphics(undefined, false);
    g.fillStyle(0x0033cc, 0.3).fillRect(0, 0, W, H);
    g.fillStyle(0x44aaff, 1).fillRect(1, 0, W - 2, H);
    g.fillStyle(0xddf4ff, 1).fillRect(2, 0, W - 4, H);
    g.generateTexture('laser_bolt', W, H);
    g.destroy();
  }

  shootIfReady(time: number, firing: boolean): void {
    if (!firing || time < this.cooldownUntil) return;
    const mega = this.isMega();
    if (!mega && this.charges < 1) return;
    if (!mega) this.charges -= 1;
    this.fire();
    this.cooldownUntil = time + (mega ? BONUS_MEGA_COOLDOWN_MS : LASER_COOLDOWN_MS);
  }

  /** Regenerate the gauge; grant the bonus charge immediately on level-up. */
  private regen(delta: number): void {
    const max = this.maxCharges();
    if (max > this.prevMax) this.charges += max - this.prevMax;
    this.prevMax = max;
    this.charges = Math.min(max, this.charges + delta / LASER_CHARGE_REGEN_MS);
  }

  private fire(): void {
    const ship   = this.deps.ship();
    const level  = this.deps.level();
    const range  = LASER_BASE_RANGE + Math.floor(level / 5) * LASER_RANGE_STEP;
    const scale  = shipScaleForLevel(level);
    const nose   = 45 * scale;
    const fwdRad = ship.rotation - Math.PI / 2;
    const noseX  = ship.x + Math.cos(fwdRad) * nose;
    const noseY  = ship.y + Math.sin(fwdRad) * nose;

    if (level < LASER_CONE_LEVEL) {
      // Straight parallel lasers
      const count = Math.min(Math.floor(level / 5) + 1, 5);
      const half  = ((count - 1) / 2) * LASER_WING_SPACING;
      const latX  = Math.cos(ship.rotation);
      const latY  = Math.sin(ship.rotation);
      const vx    = Math.cos(fwdRad) * LASER_SPEED;
      const vy    = Math.sin(fwdRad) * LASER_SPEED;
      for (let i = 0; i < count; i++) {
        const d = -half + i * LASER_WING_SPACING;
        this.spawnBolt(noseX + latX * d, noseY + latY * d, vx, vy, ship.rotation, range);
      }
    } else {
      // Cone / fan mode
      const count = Math.min(3 + Math.floor((level - LASER_CONE_LEVEL) / 5), 10);
      const half  = ((count - 1) / 2) * LASER_CONE_STEP_DEG;
      for (let i = 0; i < count; i++) {
        const offsetRad = (-half + i * LASER_CONE_STEP_DEG) * (Math.PI / 180);
        const angleRad  = fwdRad + offsetRad;
        this.spawnBolt(noseX, noseY, Math.cos(angleRad) * LASER_SPEED, Math.sin(angleRad) * LASER_SPEED, ship.rotation + offsetRad, range);
      }
    }

    this.scene.sound.play('sfx_laser', { volume: 0.15 });
  }

  spawnBolt(
    x: number, y: number, vx: number, vy: number,
    rotation: number, range: number, remote = false, shooterId?: number,
  ): void {
    const image = this.scene.add.image(x, y, 'laser_bolt').setRotation(rotation).setDepth(5);
    this.bolts.push({ image, vx, vy, range, traveled: 0, ...(remote ? { remote: true as const, shooterId } : {}) });
  }

  /** Destroy every in-flight bolt (called on death). */
  clearAll(): void {
    for (const b of this.bolts) b.image.destroy();
    this.bolts = [];
  }

  update(delta: number): void {
    this.regen(delta);
    const dt = delta / 1000;
    for (let i = this.bolts.length - 1; i >= 0; i--) {
      const bolt = this.bolts[i];
      bolt.traveled += LASER_SPEED * dt;
      bolt.image.x  += bolt.vx * dt;
      bolt.image.y  += bolt.vy * dt;

      if (bolt.traveled >= bolt.range) {
        bolt.image.destroy();
        this.bolts.splice(i, 1);
        continue;
      }

      // Incoming bot laser → damage only on real contact with my ship.
      if (bolt.remote) {
        const ship = this.deps.ship();
        if (!this.deps.isDead() && ship.visible && this.scene.time.now >= this.deps.invincibleUntil()) {
          const myRadius = (ship.displayWidth / 2) * LASER_HIT_FRACTION;
          if (Phaser.Math.Distance.Between(bolt.image.x, bolt.image.y, ship.x, ship.y) < myRadius) {
            showLaserHit(this.scene, bolt.image.x, bolt.image.y);
            this.deps.hitSelf(BOT_SHOOT_DAMAGE, bolt.shooterId ?? null);
            bolt.image.destroy();
            this.bolts.splice(i, 1);
          }
        }
        continue;
      }

      // My laser → hit the first visible remote ship it touches.
      for (const [hitId, sprite] of this.deps.remoteShips.entries()) {
        if (!sprite.visible) continue;
        const hitRadius = (sprite.displayWidth / 2) * LASER_HIT_FRACTION;
        if (Phaser.Math.Distance.Between(bolt.image.x, bolt.image.y, sprite.x, sprite.y) < hitRadius) {
          showLaserHit(this.scene, bolt.image.x, bolt.image.y);
          this.deps.onHitRemote(hitId);
          bolt.image.destroy();
          this.bolts.splice(i, 1);
          break;
        }
      }
    }
  }
}
