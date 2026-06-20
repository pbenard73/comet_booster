import Phaser from 'phaser';
import { WORLD_WIDTH, WORLD_HEIGHT, SERVER_TICK_MS, AOI_RADIUS, SHIP_SPRITE_FIT, torusDelta } from '@shared/constants';
import type { PlayerState, BonusType } from '@shared/types';
import { shipClass, type ShipClassId } from '@shared/classes';
import { bossProfile } from '@shared/bosses';
import { shipKey, NAME_LABEL_DIST } from './ui-constants';
import { shipSpriteScale, shipScaleForLevel, maxHpForLevel } from './scale';
import { nearestImage } from './torus';
import { drawHpBar } from './healthbar';
import { startBlink } from './effects';

/** Render remote ships this many ms in the past, interpolating between the two
 *  server snapshots that bracket that time. Two ticks of buffer absorbs network
 *  jitter so motion stays smooth even though positions only arrive at 20 Hz. */
const INTERP_DELAY_MS = SERVER_TICK_MS * 2;
/** A jump larger than this (teleport bonus, respawn, AoI re-entry) is snapped
 *  instead of interpolated, so a ship never glides across the map. */
const SNAP_DIST = AOI_RADIUS;
/** Angle smoothing time constant (ms): turn-rate saccade is eased exponentially. */
const ANGLE_TAU_MS = 60;

/** One timestamped server position sample (wrapped world coords). */
interface Snap { x: number; y: number; t: number; }

/**
 * Owns every remote ship: its sprite, floating name label, level, client-side HP
 * estimate (the server doesn't broadcast HP), and authoritative torus-wrapped
 * world coord. Each frame the sprites are re-placed at the torus image nearest
 * the local ship (see updatePositions), then labels + HP bars are drawn for the
 * nearby visible ones only — ~250 ships otherwise dominate the frame cost.
 */
export class RemoteShips {
  private sprites_ = new Map<number, Phaser.GameObjects.Image>();
  private labels   = new Map<number, Phaser.GameObjects.Text>();
  private levels   = new Map<number, number>();
  private hp       = new Map<number, number>();
  private world    = new Map<number, Snap[]>();      // recent server position samples (for interpolation)
  private angleT   = new Map<number, number>();      // target heading (deg); sprite angle eases toward it
  private shieldUntil = new Map<number, number>();   // ms timestamp the shield ring stops showing
  private names    = new Map<number, string>();      // raw pseudo (label text adds ⭐ for teammates)
  private classes  = new Map<number, ShipClassId>(); // each ship's RPG class (drives marker + max HP)
  private teams    = new Map<number, number>();      // each ship's teamId (0 = none)
  private localTeam = 0;                             // the viewer's own teamId
  private botIds   = new Set<number>();              // ids that are AI bots (dev)
  private bosses   = new Map<number, string>();      // boss ids → boss profile id (3× size, purple blip, huge HP)
  readonly healthBars: Phaser.GameObjects.Graphics;

  constructor(private scene: Phaser.Scene) {
    // One world-space Graphics holds every ship's mini HP bar (cheaper than a bar
    // object per ship); cleared + redrawn each frame for nearby ships only.
    this.healthBars = scene.add.graphics().setDepth(6);
  }

  get size(): number { return this.sprites_.size; }
  has(id: number): boolean { return this.sprites_.has(id); }
  get(id: number): Phaser.GameObjects.Image | undefined { return this.sprites_.get(id); }
  levelOf(id: number): number { return this.levels.get(id) ?? 1; }
  classOf(id: number): ShipClassId { return this.classes.get(id) ?? 'normal'; }
  sprites(): IterableIterator<Phaser.GameObjects.Image> { return this.sprites_.values(); }
  entries(): IterableIterator<[number, Phaser.GameObjects.Image]> { return this.sprites_.entries(); }

  spawn(player: PlayerState): void {
    // A boss is rendered 3× a full-grown ship (sizeMult) and above normal ships.
    const boss = bossProfile(player.boss);
    const sprite = this.scene.add.image(player.x, player.y, shipKey(player.ship))
      .setAngle(player.angle).setDepth(boss ? 4 : 3).setVisible(!player.dead)
      .setScale(boss ? boss.sizeMult * SHIP_SPRITE_FIT : shipSpriteScale(player.level));
    this.sprites_.set(player.id, sprite);
    this.levels.set(player.id, player.level);
    this.classes.set(player.id, player.cls ?? 'normal');
    if (boss) this.bosses.set(player.id, boss.id);
    this.hp.set(player.id, boss ? boss.hp : maxHpForLevel(player.level, player.cls));
    this.resetWorld(player.id, player.x, player.y);
    this.angleT.set(player.id, player.angle);

    const label = this.scene.add.text(player.x, player.y, player.name, {
      fontSize: '12px', color: '#cfe8ff', fontFamily: 'Kenney, monospace',
      stroke: '#000000', strokeThickness: 3,
    }).setOrigin(0.5, 1).setDepth(6).setVisible(false);
    this.labels.set(player.id, label);
    this.names.set(player.id, player.name);
    this.teams.set(player.id, player.teamId ?? 0);
    // classes already set above (needed before applyLabelStyle for the marker)
    if (player.bot) this.botIds.add(player.id);
    this.applyLabelStyle(player.id);
  }

  /** True for AI bots — human laser hits are kept visual-free, bot hits aren't. */
  isBot(id: number): boolean { return this.botIds.has(id); }

  /** True for the world boss (purple radar blip, 3× size). */
  isBoss(id: number): boolean { return this.bosses.has(id); }

  /** A boss's bolt range (its profile shootRange) for an id, or undefined for a
   *  normal ship/bot — lets remote bolts skip the LASER_MAX_RANGE cap for bosses. */
  bossShootRangeOf(id: number): number | undefined {
    const bid = this.bosses.get(id);
    return bid ? bossProfile(bid)?.shootRange : undefined;
  }

  /** Logical collision scale: a boss's sizeMult, else the level-based ship scale. */
  collisionScaleOf(id: number): number {
    const bid = this.bosses.get(id);
    return bid ? (bossProfile(bid)?.sizeMult ?? 1) : shipScaleForLevel(this.levelOf(id));
  }

  /** Max HP for an id — a boss's huge pool, else the level/class formula. */
  private maxHpOf(id: number): number {
    const bid = this.bosses.get(id);
    return bid ? (bossProfile(bid)?.hp ?? 1) : maxHpForLevel(this.levels.get(id) ?? 1, this.classes.get(id));
  }

  /** True when this ship shares the viewer's (non-zero) team. */
  isTeammate(id: number): boolean {
    return this.localTeam !== 0 && this.teams.get(id) === this.localTeam;
  }

  /** Update one ship's team membership (from `team_set`) and restyle its label. */
  setTeam(id: number, teamId: number): void {
    this.teams.set(id, teamId);
    this.applyLabelStyle(id);
  }

  /** Update one ship's class (from `player_class`): restyle the label marker and
   *  rescale its HP estimate to the new max (keeping the same fraction). */
  setClass(id: number, cls: ShipClassId): void {
    if (this.bosses.has(id)) return;   // bosses have no class
    const prevMax = maxHpForLevel(this.levels.get(id) ?? 1, this.classes.get(id));
    const frac    = prevMax > 0 ? (this.hp.get(id) ?? prevMax) / prevMax : 1;
    this.classes.set(id, cls);
    this.hp.set(id, maxHpForLevel(this.levels.get(id) ?? 1, cls) * frac);
    this.applyLabelStyle(id);
  }

  /** The viewer's own team changed → re-evaluate every label's teammate styling. */
  setLocalTeam(teamId: number): void {
    this.localTeam = teamId;
    for (const id of this.labels.keys()) this.applyLabelStyle(id);
  }

  /** Label = class marker + pseudo. Teammates override to green-with-stars; everyone
   *  else shows their class colour (default blue for 'normal'). */
  private applyLabelStyle(id: number): void {
    const label = this.labels.get(id);
    if (!label) return;
    const name   = this.names.get(id) ?? '';
    // Boss: distinct purple ☠ label, overriding class/team styling.
    if (this.bosses.has(id)) { label.setText(`☠ ${name} ☠`).setColor('#b266ff'); return; }
    const cls    = shipClass(this.classes.get(id));
    const marked = cls.marker ? `${cls.marker} ${name}` : name;
    if (this.isTeammate(id)) label.setText(`⭐ ${marked} ⭐`).setColor('#33ff66');
    else                     label.setText(marked).setColor(cls.id !== 'normal' ? cls.color : '#cfe8ff');
  }

  remove(id: number): void {
    this.sprites_.get(id)?.destroy();
    this.sprites_.delete(id);
    this.labels.get(id)?.destroy();
    this.labels.delete(id);
    this.levels.delete(id);
    this.hp.delete(id);
    this.world.delete(id);
    this.angleT.delete(id);
    this.shieldUntil.delete(id);
    this.names.delete(id);
    this.classes.delete(id);
    this.teams.delete(id);
    this.botIds.delete(id);
    this.bosses.delete(id);
  }

  /** Render a power-up effect on a remote ship (driven by `player_effect`):
   *  invincible → blink, mega_weapon → hot tint, shield → ring (in drawLabels). */
  showEffect(id: number, kind: BonusType, ms: number): void {
    const sprite = this.sprites_.get(id);
    if (!sprite) return;
    if (kind === 'invincible') {
      startBlink(this.scene, sprite, ms);
    } else if (kind === 'mega_weapon') {
      sprite.setTint(0xff7744);
      this.scene.time.delayedCall(ms, () => sprite.clearTint());
    } else if (kind === 'shield') {
      this.shieldUntil.set(id, this.scene.time.now + ms);
    }
  }

  rename(id: number, name: string): void { this.names.set(id, name); this.applyLabelStyle(id); }

  /** Append an authoritative (server, wrapped) world position sample. Far jumps
   *  (teleport / respawn / AoI re-entry) reset the buffer so the ship snaps there
   *  instead of gliding across the world. */
  setWorld(id: number, x: number, y: number): void {
    const buf = this.world.get(id);
    if (!buf) { this.resetWorld(id, x, y); return; }
    const last = buf[buf.length - 1];
    if (Math.abs(torusDelta(x, last.x, WORLD_WIDTH)) > SNAP_DIST ||
        Math.abs(torusDelta(y, last.y, WORLD_HEIGHT)) > SNAP_DIST) {
      this.resetWorld(id, x, y);
      return;
    }
    buf.push({ x, y, t: this.scene.time.now });
    // Keep only what the interpolation window needs (the sample just past renderT
    // plus everything newer) — drop the rest so the buffer can't grow unbounded.
    const cutoff = this.scene.time.now - INTERP_DELAY_MS;
    while (buf.length > 2 && buf[1].t <= cutoff) buf.shift();
  }

  /** Reset the position buffer to a single sample (snap target). */
  private resetWorld(id: number, x: number, y: number): void {
    this.world.set(id, [{ x, y, t: this.scene.time.now }]);
  }

  setAngle(id: number, angle: number): void { this.angleT.set(id, angle); }

  applyDamage(id: number, amount: number): void {
    const hp = this.hp.get(id);
    if (hp !== undefined) this.hp.set(id, Math.max(0, hp - amount));
  }

  /** Resize + reset HP to full on a remote level-up. */
  levelUp(id: number, level: number): void {
    this.levels.set(id, level);
    this.hp.set(id, maxHpForLevel(level, this.classes.get(id)));
    this.sprites_.get(id)?.setScale(shipSpriteScale(level));
  }

  respawn(id: number, x: number, y: number, level: number, shipX: number, shipY: number): void {
    this.levels.set(id, level);
    this.hp.set(id, maxHpForLevel(level, this.classes.get(id)));
    this.resetWorld(id, x, y);   // snap to the respawn point, don't interpolate from the death spot
    this.angleT.set(id, 0);
    this.sprites_.get(id)
      ?.setPosition(nearestImage(x, shipX, WORLD_WIDTH), nearestImage(y, shipY, WORLD_HEIGHT))
      .setAngle(0).setVisible(true).setScale(shipSpriteScale(level));
  }

  /**
   * Re-place every sprite at the torus image nearest the local ship, using
   * **entity interpolation**: rather than snapping to the latest 20 Hz sample
   * (visibly jerky, more so the faster ships move), each sprite is rendered
   * INTERP_DELAY_MS in the past, lerping between the two server samples that
   * bracket that render time. The heading eases toward its target exponentially.
   */
  updatePositions(shipX: number, shipY: number): void {
    const now     = this.scene.time.now;
    const renderT = now - INTERP_DELAY_MS;
    const dt      = this.scene.game.loop.delta;            // ms since last frame
    const aLerp   = dt > 0 ? 1 - Math.exp(-dt / ANGLE_TAU_MS) : 1;

    for (const [id, sprite] of this.sprites_) {
      const buf = this.world.get(id);
      if (buf && buf.length) {
        // Find the pair of samples straddling renderT (clamp at the ends: hold the
        // oldest if renderT precedes it, the newest if no fresher sample exists yet).
        let wx = buf[buf.length - 1].x, wy = buf[buf.length - 1].y;
        for (let i = 0; i < buf.length - 1; i++) {
          const a = buf[i], b = buf[i + 1];
          if (renderT <= b.t) {
            const span = b.t - a.t;
            const f    = span > 0 ? Math.min(1, Math.max(0, (renderT - a.t) / span)) : 1;
            wx = a.x + torusDelta(b.x, a.x, WORLD_WIDTH)  * f;   // lerp across the seam correctly
            wy = a.y + torusDelta(b.y, a.y, WORLD_HEIGHT) * f;
            break;
          }
        }
        sprite.setPosition(nearestImage(wx, shipX, WORLD_WIDTH), nearestImage(wy, shipY, WORLD_HEIGHT));
      }

      const target = this.angleT.get(id);
      if (target !== undefined) {
        sprite.angle += Phaser.Math.Angle.ShortestBetween(sprite.angle, target) * aLerp;
      }
    }
  }

  /**
   * Draw HP bars (into the shared, already-cleared healthBars) and position name
   * labels for nearby visible ships; cull the rest. Called after the local ship's
   * own bar has been drawn into the same Graphics.
   */
  drawLabels(shipX: number, shipY: number): void {
    const maxSq = NAME_LABEL_DIST * NAME_LABEL_DIST;
    for (const [id, sprite] of this.sprites_) {
      const label = this.labels.get(id);
      if (!label) continue;
      const dx = sprite.x - shipX, dy = sprite.y - shipY;
      if (sprite.visible && dx * dx + dy * dy <= maxSq) {
        const maxHp = this.maxHpOf(id);
        const hp    = this.hp.get(id) ?? maxHp;
        const nameY = drawHpBar(this.healthBars, sprite.x, sprite.y - sprite.displayHeight / 2, hp, maxHp);
        label.setVisible(true).setPosition(sprite.x, nameY);
        const su = this.shieldUntil.get(id);
        if (su !== undefined) {
          if (this.scene.time.now < su) {
            this.healthBars.lineStyle(2, 0x66ddff, 0.7).strokeCircle(sprite.x, sprite.y, sprite.displayWidth * 0.7);
          } else {
            this.shieldUntil.delete(id);
          }
        }
      } else if (label.visible) {
        label.setVisible(false);
      }
    }
  }
}
