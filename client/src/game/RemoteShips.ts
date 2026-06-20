import Phaser from 'phaser';
import { WORLD_WIDTH, WORLD_HEIGHT } from '@shared/constants';
import type { PlayerState, BonusType } from '@shared/types';
import { shipKey, NAME_LABEL_DIST } from './ui-constants';
import { shipSpriteScale, maxHpForLevel } from './scale';
import { nearestImage } from './torus';
import { drawHpBar } from './healthbar';
import { startBlink } from './effects';

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
  private world    = new Map<number, { x: number; y: number }>();
  private shieldUntil = new Map<number, number>();   // ms timestamp the shield ring stops showing
  private names    = new Map<number, string>();      // raw pseudo (label text adds ⭐ for teammates)
  private teams    = new Map<number, number>();      // each ship's teamId (0 = none)
  private localTeam = 0;                             // the viewer's own teamId
  private botIds   = new Set<number>();              // ids that are AI bots (dev)
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
  sprites(): IterableIterator<Phaser.GameObjects.Image> { return this.sprites_.values(); }
  entries(): IterableIterator<[number, Phaser.GameObjects.Image]> { return this.sprites_.entries(); }

  spawn(player: PlayerState): void {
    const sprite = this.scene.add.image(player.x, player.y, shipKey(player.ship))
      .setAngle(player.angle).setDepth(3).setVisible(!player.dead)
      .setScale(shipSpriteScale(player.level));
    this.sprites_.set(player.id, sprite);
    this.levels.set(player.id, player.level);
    this.hp.set(player.id, maxHpForLevel(player.level));
    this.setWorld(player.id, player.x, player.y);

    const label = this.scene.add.text(player.x, player.y, player.name, {
      fontSize: '12px', color: '#cfe8ff', fontFamily: 'Kenney, monospace',
      stroke: '#000000', strokeThickness: 3,
    }).setOrigin(0.5, 1).setDepth(6).setVisible(false);
    this.labels.set(player.id, label);
    this.names.set(player.id, player.name);
    this.teams.set(player.id, player.teamId ?? 0);
    if (player.bot) this.botIds.add(player.id);
    this.applyLabelStyle(player.id);
  }

  /** True for AI bots — human laser hits are kept visual-free, bot hits aren't. */
  isBot(id: number): boolean { return this.botIds.has(id); }

  /** True when this ship shares the viewer's (non-zero) team. */
  isTeammate(id: number): boolean {
    return this.localTeam !== 0 && this.teams.get(id) === this.localTeam;
  }

  /** Update one ship's team membership (from `team_set`) and restyle its label. */
  setTeam(id: number, teamId: number): void {
    this.teams.set(id, teamId);
    this.applyLabelStyle(id);
  }

  /** The viewer's own team changed → re-evaluate every label's teammate styling. */
  setLocalTeam(teamId: number): void {
    this.localTeam = teamId;
    for (const id of this.labels.keys()) this.applyLabelStyle(id);
  }

  /** Teammates show their pseudo in green wrapped in stars; everyone else default. */
  private applyLabelStyle(id: number): void {
    const label = this.labels.get(id);
    if (!label) return;
    const name = this.names.get(id) ?? '';
    if (this.isTeammate(id)) label.setText(`⭐ ${name} ⭐`).setColor('#33ff66');
    else                     label.setText(name).setColor('#cfe8ff');
  }

  remove(id: number): void {
    this.sprites_.get(id)?.destroy();
    this.sprites_.delete(id);
    this.labels.get(id)?.destroy();
    this.labels.delete(id);
    this.levels.delete(id);
    this.hp.delete(id);
    this.world.delete(id);
    this.shieldUntil.delete(id);
    this.names.delete(id);
    this.teams.delete(id);
    this.botIds.delete(id);
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

  /** Store a ship's authoritative (server, wrapped) world position. */
  setWorld(id: number, x: number, y: number): void {
    const w = this.world.get(id);
    if (w) { w.x = x; w.y = y; }
    else    this.world.set(id, { x, y });
  }

  setAngle(id: number, angle: number): void { this.sprites_.get(id)?.setAngle(angle); }

  applyDamage(id: number, amount: number): void {
    const hp = this.hp.get(id);
    if (hp !== undefined) this.hp.set(id, Math.max(0, hp - amount));
  }

  /** Resize + reset HP to full on a remote level-up. */
  levelUp(id: number, level: number): void {
    this.levels.set(id, level);
    this.hp.set(id, maxHpForLevel(level));
    this.sprites_.get(id)?.setScale(shipSpriteScale(level));
  }

  respawn(id: number, x: number, y: number, level: number, shipX: number, shipY: number): void {
    this.levels.set(id, level);
    this.hp.set(id, maxHpForLevel(level));
    this.setWorld(id, x, y);
    this.sprites_.get(id)
      ?.setPosition(nearestImage(x, shipX, WORLD_WIDTH), nearestImage(y, shipY, WORLD_HEIGHT))
      .setAngle(0).setVisible(true).setScale(shipSpriteScale(level));
  }

  /** Re-place every sprite at the torus image nearest the local ship. */
  updatePositions(shipX: number, shipY: number): void {
    for (const [id, sprite] of this.sprites_) {
      const w = this.world.get(id);
      if (w) sprite.setPosition(nearestImage(w.x, shipX, WORLD_WIDTH), nearestImage(w.y, shipY, WORLD_HEIGHT));
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
        const maxHp = maxHpForLevel(this.levels.get(id) ?? 1);
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
