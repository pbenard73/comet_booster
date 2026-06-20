import Phaser from 'phaser';
import {
  LASER_SPEED, LASER_COOLDOWN_MS, LASER_BASE_RANGE, LASER_RANGE_STEP, LASER_MAX_RANGE,
  LASER_CONE_LEVEL, LASER_CONE_STEP_DEG, LASER_WING_SPACING,
  LASER_BASE_CHARGES, LASER_CHARGE_REGEN_MS, LASER_CHARGES_PER_5LV, LASER_MAX_CHARGES,
  LASER_HIT_FRACTION, BOT_SHOOT_DAMAGE, BONUS_MEGA_COOLDOWN_MS,
  WORLD_WIDTH, WORLD_HEIGHT, inSafeZone,
} from '@shared/constants';
import { shipClass, type ShipClassId } from '@shared/classes';
import { wrap } from './torus';
import { shipScaleForLevel } from './scale';
import { showLaserHit, showForceFieldHit } from './effects';
import type { RemoteShips } from './RemoteShips';

interface Bolt {
  image: Phaser.GameObjects.Image;
  vx: number; vy: number;
  speed: number;                  // |velocity| px/s — drives the traveled/range cap
  range: number; traveled: number;
  remote?: true;
  shooterId?: number;
}

/** What the laser system needs from the scene to resolve fire & damage. */
export interface LaserDeps {
  ship: () => Phaser.Physics.Arcade.Image;
  level: () => number;
  cls: () => ShipClassId;
  isDead: () => boolean;
  invincibleUntil: () => number;
  remoteShips: RemoteShips;
  speedMult: () => number;                                    // global game-speed multiplier (scales bolt speed + range)
  onHitRemote: (id: number) => void;                          // landed our bolt on a ship
  hitSelf: (amount: number, shooterId: number | null) => void; // an incoming bolt reached us
  onFire: (bolts: Array<{ x: number; y: number; vx: number; vy: number }>) => void; // broadcast my bolts so others see them
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

  // Throttle the refuge-deflection "bong" so a volley hitting the field at once
  // doesn't stack a wall of sound.
  private lastDeflectSound = 0;

  constructor(private scene: Phaser.Scene, private deps: LaserDeps) {
    this.buildTexture();
  }

  /** Activate the mega-weapon (unlimited rapid fire) for `ms`. */
  activateMega(ms: number): void { this.megaUntil = this.scene.time.now + ms; }
  deactivateMega(): void { this.megaUntil = 0; }
  isMega(): boolean { return this.scene.time.now < this.megaUntil; }
  megaRemainingMs(): number { return Math.max(0, this.megaUntil - this.scene.time.now); }

  /** Max charges for the current level — one extra every 5 levels, capped at
   *  LASER_MAX_CHARGES (20) regardless of level, plus the class's bonus charges
   *  (e.g. Engineer's deep magazine) added ON TOP of the cap. */
  maxCharges(): number {
    const byLevel = LASER_BASE_CHARGES + Math.floor(this.deps.level() / 5) * LASER_CHARGES_PER_5LV;
    return Math.min(byLevel, LASER_MAX_CHARGES) + shipClass(this.deps.cls()).bonusCharges;
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
    const cooldown = LASER_COOLDOWN_MS * shipClass(this.deps.cls()).fireCooldownMult;
    this.cooldownUntil = time + (mega ? BONUS_MEGA_COOLDOWN_MS : cooldown);
  }

  /** Regenerate the gauge; grant the bonus charge immediately on level-up. */
  private regen(delta: number): void {
    const max = this.maxCharges();
    if (max > this.prevMax) this.charges += max - this.prevMax;
    this.prevMax = max;
    const regenMs = LASER_CHARGE_REGEN_MS / shipClass(this.deps.cls()).chargeRegenMult;
    this.charges = Math.min(max, this.charges + delta / regenMs);
  }

  private fire(): void {
    const ship   = this.deps.ship();
    const level  = this.deps.level();
    // Bolt speed and range both scale with the global game speed (same as ships),
    // so faster games keep shots proportional rather than feeling sluggish.
    const mult   = this.deps.speedMult();
    const speed  = LASER_SPEED * mult;
    // Level grows the base range, but it saturates at LASER_MAX_RANGE (~level 5)
    // regardless of level; only the global speed and the class rangeMult extend it.
    const baseRange = Math.min(LASER_BASE_RANGE + Math.floor(level / 5) * LASER_RANGE_STEP, LASER_MAX_RANGE);
    const range  = baseRange * shipClass(this.deps.cls()).rangeMult * mult;
    const scale  = shipScaleForLevel(level);
    const nose   = 45 * scale;
    const fwdRad = ship.rotation - Math.PI / 2;
    const noseX  = ship.x + Math.cos(fwdRad) * nose;
    const noseY  = ship.y + Math.sin(fwdRad) * nose;

    // Collect each bolt's spawn so the volley can be broadcast for other clients.
    const fired: Array<{ x: number; y: number; vx: number; vy: number }> = [];

    if (level < LASER_CONE_LEVEL) {
      // Straight parallel lasers
      const count = Math.min(Math.floor(level / 5) + 1, 5);
      const half  = ((count - 1) / 2) * LASER_WING_SPACING;
      const latX  = Math.cos(ship.rotation);
      const latY  = Math.sin(ship.rotation);
      const vx    = Math.cos(fwdRad) * speed;
      const vy    = Math.sin(fwdRad) * speed;
      for (let i = 0; i < count; i++) {
        const d = -half + i * LASER_WING_SPACING;
        const bx = noseX + latX * d, by = noseY + latY * d;
        this.spawnBolt(bx, by, vx, vy, ship.rotation, range);
        fired.push({ x: bx, y: by, vx, vy });
      }
    } else {
      // Cone / fan mode
      const count = Math.min(3 + Math.floor((level - LASER_CONE_LEVEL) / 5), 10);
      const half  = ((count - 1) / 2) * LASER_CONE_STEP_DEG;
      for (let i = 0; i < count; i++) {
        const offsetRad = (-half + i * LASER_CONE_STEP_DEG) * (Math.PI / 180);
        const angleRad  = fwdRad + offsetRad;
        const vx = Math.cos(angleRad) * speed, vy = Math.sin(angleRad) * speed;
        this.spawnBolt(noseX, noseY, vx, vy, ship.rotation + offsetRad, range);
        fired.push({ x: noseX, y: noseY, vx, vy });
      }
    }

    this.deps.onFire(fired);
    this.scene.sound.play('sfx_laser', { volume: 0.15 });
  }

  spawnBolt(
    x: number, y: number, vx: number, vy: number,
    rotation: number, range: number, remote = false, shooterId?: number,
  ): void {
    const image = this.scene.add.image(x, y, 'laser_bolt').setRotation(rotation).setDepth(5);
    const speed = Math.hypot(vx, vy);   // remote bolts already arrive game-speed-scaled by the shooter
    this.bolts.push({ image, vx, vy, speed, range, traveled: 0, ...(remote ? { remote: true as const, shooterId } : {}) });
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
      bolt.traveled += bolt.speed * dt;
      bolt.image.x  += bolt.vx * dt;
      bolt.image.y  += bolt.vy * dt;

      if (bolt.traveled >= bolt.range) {
        bolt.image.destroy();
        this.bolts.splice(i, 1);
        continue;
      }

      // Refuge force field: a laser can't enter a safe zone — it's deflected at
      // the boundary with a "bong" and a ripple, no matter who fired it.
      if (inSafeZone(wrap(bolt.image.x, WORLD_WIDTH), wrap(bolt.image.y, WORLD_HEIGHT))) {
        showForceFieldHit(this.scene, bolt.image.x, bolt.image.y);
        const now = this.scene.time.now;
        if (now - this.lastDeflectSound > 60) {
          this.lastDeflectSound = now;
          this.scene.sound.play('sfx_deflect', { volume: 0.5, rate: 0.6 });
        }
        bolt.image.destroy();
        this.bolts.splice(i, 1);
        continue;
      }

      // Incoming bot laser → damage only on real contact with my ship.
      if (bolt.remote) {
        const ship = this.deps.ship();
        // No friendly fire: a teammate's bolt flies through us untouched.
        const teammate = bolt.shooterId !== undefined && this.deps.remoteShips.isTeammate(bolt.shooterId);
        if (!teammate && !this.deps.isDead() && ship.visible && this.scene.time.now >= this.deps.invincibleUntil()) {
          const myRadius = (ship.displayWidth / 2) * LASER_HIT_FRACTION;
          if (Phaser.Math.Distance.Between(bolt.image.x, bolt.image.y, ship.x, ship.y) < myRadius) {
            showLaserHit(this.scene, bolt.image.x, bolt.image.y);
            // Bot bolts deal their damage here; human bolts are visual only —
            // a human's damage arrives authoritatively via `player_hit`.
            if (bolt.shooterId !== undefined && this.deps.remoteShips.isBot(bolt.shooterId)) {
              this.deps.hitSelf(BOT_SHOOT_DAMAGE, bolt.shooterId);
            }
            bolt.image.destroy();
            this.bolts.splice(i, 1);
          }
        }
        continue;
      }

      // My laser → hit the first visible remote ship it touches (teammates are
      // skipped: no friendly fire, the bolt passes through them).
      for (const [hitId, sprite] of this.deps.remoteShips.entries()) {
        if (!sprite.visible || this.deps.remoteShips.isTeammate(hitId)) continue;
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
