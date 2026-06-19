import Phaser from 'phaser';
import { Network } from '../network/Network';
import {
  WORLD_WIDTH, WORLD_HEIGHT,
  PLAYER_SPEED, PLAYER_ROTATION_SPEED, PLAYER_THRUST_SPEED, SEND_RATE_MS,
  BOOST_SPEED_MULT, BOOST_DURATION_MS, BOOST_REGEN_MS, BOOST_MIN_CHARGE,
  COLLISION_RADIUS, BASE_HP, DAMAGE_PER_HIT, DAMAGE_COOLDOWN_MS,
  KNOCKBACK_STUN_MS, KNOCKBACK_SPEED_MULT, KNOCKBACK_SPIN_DEG,
  BOT_SHOOT_RANGE, XP_TO_LEVEL,
  BONUS_PICKUP_PAD, BONUS_SIZE_PX, BONUS_INVINCIBLE_MS, BONUS_MEGA_MS,
  BONUS_SHIELD_HITS, BONUS_TELEPORT_INVINCIBLE_MS, BONUS_SHIELD_VISUAL_MS,
} from '@shared/constants';
import type { BonusType } from '@shared/types';
import { shipKey, ENGINE_OFFSET, INVINCIBLE_MS } from '../game/ui-constants';
import { shipScaleForLevel, shipSpriteScale, maxHpForLevel } from '../game/scale';
import { wrap, nearestImage } from '../game/torus';
import { drawHpBar } from '../game/healthbar';
import { showExplosion, showLaserHit, showLevelUpEffect, startBlink, showDeathOverlay, showShieldBlock } from '../game/effects';
import { Starfield } from '../game/Starfield';
import { Radar } from '../game/Radar';
import { Hud } from '../game/Hud';
import { RemoteShips } from '../game/RemoteShips';
import { LaserSystem } from '../game/LaserSystem';
import { BonusSystem } from '../game/BonusSystem';

/**
 * The game loop orchestrator. Owns the local player's state and ship, wires the
 * network handlers, and delegates rendering subsystems to dedicated modules in
 * `client/src/game/` (starfield, radar globe, HUD, remote ships, lasers, effects).
 */
export class GameScene extends Phaser.Scene {
  private network!: Network;
  private starfield!:   Starfield;
  private radar!:       Radar;
  private hud!:         Hud;
  private remoteShips!: RemoteShips;
  private lasers!:      LaserSystem;
  private bonuses!:     BonusSystem;

  private myId: number | null = null;
  private ship!:        Phaser.Physics.Arcade.Image;
  private thruster!:    Phaser.GameObjects.Sprite;
  private myNameLabel!: Phaser.GameObjects.Text;
  private shieldAura!:  Phaser.GameObjects.Arc;
  private cursors!:     Phaser.Types.Input.Keyboard.CursorKeys;
  private spaceKey!:    Phaser.Input.Keyboard.Key;
  private shiftKey!:    Phaser.Input.Keyboard.Key;
  private ctrlKey!:     Phaser.Input.Keyboard.Key;

  // Boost gauge: 0..1 charge fraction. Drains while boosting (hold CTRL + thrust),
  // refills otherwise. `boosting` is recomputed each frame for visuals/HUD.
  // `boostEngaged` tracks an in-progress burst so it can drain to 0 once started,
  // while a fresh burst needs the gauge back up to BOOST_MIN_CHARGE first.
  private boostCharge  = 1;
  private boosting     = false;
  private boostEngaged = false;

  // Bonus state: at most one held power-up, plus the active shield's hit budget.
  private heldBonus: BonusType | null = null;
  private shieldHits = 0;
  private requestedPickups = new Set<number>();   // bonus ids we've already asked to claim

  private playerName = '';
  private isDead          = false;
  private invincibleUntil = 0;
  private stunnedUntil    = 0;
  private lastSent        = 0;
  private lastDamageTime  = 0;
  private lastDamagedBy: number | null = null;
  private myLevel = 1;
  private myHp    = BASE_HP;
  private myMaxHp = BASE_HP;
  private myXp    = 0;
  private myXpMax = XP_TO_LEVEL;

  constructor() { super('Game'); }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  init(data: { name?: string }): void {
    this.playerName = (data?.name ?? '').trim();
  }

  async create(): Promise<void> {
    this.network = new Network();
    this.myId            = null;
    this.isDead          = false;
    this.invincibleUntil = 0;
    this.stunnedUntil    = 0;
    this.lastDamageTime  = 0;
    this.lastDamagedBy   = null;
    this.myLevel = 1;
    this.myHp    = BASE_HP;
    this.myMaxHp = BASE_HP;
    this.myXp    = 0;
    this.myXpMax = XP_TO_LEVEL;
    this.heldBonus  = null;
    this.shieldHits = 0;
    this.requestedPickups.clear();
    this.boostCharge  = 1;
    this.boosting     = false;
    this.boostEngaged = false;

    this.physics.world.setBounds(0, 0, WORLD_WIDTH, WORLD_HEIGHT);

    this.starfield   = new Starfield(this);
    this.buildPlayer();
    this.remoteShips = new RemoteShips(this);
    this.bonuses     = new BonusSystem(this);
    this.radar       = new Radar(this);
    this.hud         = new Hud(this);
    this.lasers      = new LaserSystem(this, {
      ship:            () => this.ship,
      level:           () => this.myLevel,
      isDead:          () => this.isDead,
      invincibleUntil: () => this.invincibleUntil,
      remoteShips:     this.remoteShips,
      onHitRemote:     (id) => this.network.send({ type: 'hit', targetId: id }),
      hitSelf:         (amount, shooterId) => this.applyIncomingLaser(amount, shooterId),
    });
    this.bindKeys();

    // No camera bounds: the ship roams in a continuous (un-wrapped) coordinate
    // space and the camera always centres it, so crossing the world seam is
    // seamless. Everything else is rendered relative to the ship (torus world).
    this.cameras.main.startFollow(this.ship, true, 1, 1);

    this.scale.on('resize', this.onResize, this);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.scale.off('resize', this.onResize, this);
    });

    await this.connectNetwork();
  }

  update(time: number, delta: number): void {
    // Place every remote ship at its torus image nearest us, and scroll the
    // infinite starfield, before anything reads world positions this frame.
    this.remoteShips.updatePositions(this.ship.x, this.ship.y);
    this.starfield.scroll(this.ship.x, this.ship.y);
    this.bonuses.reposition(this.ship.x, this.ship.y);
    this.boosting = false;   // handleInput re-arms it when CTRL+thrust is held
    if (!this.isDead) {
      // While stunned (post-collision) the ship flies & spins on its own — no
      // control, no firing, no new collisions — until it recovers.
      if (this.stunnedUntil > 0 && time >= this.stunnedUntil) this.endStun();
      const stunned = time < this.stunnedUntil;
      if (!stunned) {
        this.handleInput();
        this.checkCollisions(time);
      }
      this.lasers.shootIfReady(time, this.spaceKey.isDown && !stunned);
      this.checkBonusPickup();
      this.sendPosition(time);
    }
    // Boost gauge: drains over BOOST_DURATION_MS while boosting, else refills
    // over BOOST_REGEN_MS (regenerates even while dead/stunned).
    if (this.boosting) this.boostCharge = Math.max(0, this.boostCharge - delta / BOOST_DURATION_MS);
    else               this.boostCharge = Math.min(1, this.boostCharge + delta / BOOST_REGEN_MS);

    this.lasers.update(delta);
    this.updateThruster();
    this.updateShieldAura();
    this.updateLabels();
    this.radar.draw(this.ship.x, this.ship.y, this.remoteShips.sprites());

    this.updateBonusHud();
    this.hud.setPlayers(this.remoteShips.size + 1);
    // The ship roams an un-wrapped continuous frame; map it to 0–360° lon/lat.
    this.hud.setCoords(
      wrap(this.ship.x, WORLD_WIDTH)  / WORLD_WIDTH  * 360,
      wrap(this.ship.y, WORLD_HEIGHT) / WORLD_HEIGHT * 360,
    );
    this.hud.setLevelHp(this.myLevel, this.myHp, this.myMaxHp);
    this.hud.setXp(this.myXp, this.myXpMax);
    this.hud.setAmmo(this.lasers.getCharges(), this.lasers.maxCharges());
    this.hud.setBoost(this.boostCharge, this.boosting, this.boostCharge >= BOOST_MIN_CHARGE);
  }

  private onResize(gameSize: Phaser.Structs.Size): void {
    const { width, height } = gameSize;
    this.cameras.main.setViewport(0, 0, width, height);
    this.starfield.resize(width, height);
    this.hud.resize(width, height);
  }

  // ── Setup ──────────────────────────────────────────────────────────────────

  private buildPlayer(): void {
    const cx = WORLD_WIDTH / 2;
    const cy = WORLD_HEIGHT / 2;
    const s  = shipScaleForLevel(1);

    this.thruster = this.add.sprite(cx, cy + ENGINE_OFFSET * s, 'fire00')
      .setScale(0.55 * s).setDepth(2).setVisible(false);
    this.thruster.play('thruster');

    this.ship = this.physics.add
      .image(cx, cy, shipKey(0))   // placeholder — real sprite assigned from the 'init' message
      .setDamping(true).setDrag(0.98).setMaxVelocity(PLAYER_SPEED)
      .setDepth(3).setScale(shipSpriteScale(1));

    this.myNameLabel = this.add.text(cx, cy, this.playerName, {
      fontSize: '12px', color: '#ffee88', fontFamily: 'Kenney, monospace',
      stroke: '#000000', strokeThickness: 3,
    }).setOrigin(0.5, 1).setDepth(6);

    // Shield aura ring — shown only while the shield bonus has hits left.
    this.shieldAura = this.add.circle(cx, cy, COLLISION_RADIUS, 0x66ddff, 0)
      .setStrokeStyle(3, 0x66ddff, 0.7).setDepth(4).setVisible(false);
  }

  private bindKeys(): void {
    this.cursors  = this.input.keyboard!.createCursorKeys();
    this.spaceKey = this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.SPACE);
    this.shiftKey = this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.SHIFT);
    this.ctrlKey  = this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.CTRL);
    this.shiftKey.on('down', () => this.activateHeldBonus());
    this.input.keyboard!.once('keydown-ESC', () => {
      this.network.disconnect();
      this.scene.start('Menu');
    });
  }

  // ── Networking ───────────────────────────────────────────────────────────────

  private async connectNetwork(): Promise<void> {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';

    try {
      await this.network.connect(`${proto}://${location.host}/ws`);
    } catch {
      this.hud.setStatus('Connection failed — retrying…', '#ff4444');
      this.time.delayedCall(2000, () => this.connectNetwork());
      return;
    }

    this.network
      .on('init', ({ id, players, bonuses }) => {
        this.myId = id;
        const me = players.find(p => p.id === id);
        if (me) {
          this.ship.setTexture(shipKey(me.ship)).setPosition(me.x, me.y);
          this.cameras.main.centerOn(me.x, me.y);
          this.myNameLabel.setText(this.playerName || me.name);
        }
        players.forEach(p => { if (p.id !== id) this.remoteShips.spawn(p); });
        bonuses.forEach(b => this.bonuses.spawn(b));
        if (this.playerName) this.network.send({ type: 'set_name', name: this.playerName });
      })
      .on('player_join', ({ player }) => {
        if (player.id !== this.myId) {
          this.remoteShips.spawn(player);
          this.sound.play('sfx_join', { volume: 0.3 });
        }
      })
      .on('player_move', ({ id, x, y, angle }) => {
        if (!this.remoteShips.has(id)) return;   // human players only — bots use bulk_move
        this.remoteShips.setWorld(id, x, y);
        this.remoteShips.setAngle(id, angle);
      })
      .on('bulk_move', ({ updates }) => {
        for (const { id, x, y, angle } of updates) {
          if (!this.remoteShips.has(id)) continue;
          this.remoteShips.setWorld(id, x, y);
          this.remoteShips.setAngle(id, angle);
        }
      })
      .on('minimap_update', ({ positions }) => {
        // Authoritative positions for ALL players (2 Hz, no AoI filter) — keeps
        // distant ships moving even when outside the 20 Hz bulk_move radius.
        for (const { id, x, y } of positions) {
          if (this.remoteShips.has(id)) this.remoteShips.setWorld(id, x, y);
        }
      })
      .on('laser_spawn', ({ shooterId, x, y, vx, vy }) => {
        if (shooterId === this.myId) return; // already rendered locally
        const rotation = Math.atan2(vy, vx) + Math.PI / 2;
        // Spawn in our continuous frame so it appears next to the firing ship.
        this.lasers.spawnBolt(
          nearestImage(x, this.ship.x, WORLD_WIDTH),
          nearestImage(y, this.ship.y, WORLD_HEIGHT),
          vx, vy, rotation, BOT_SHOOT_RANGE, true, shooterId,
        );
      })
      .on('bonus_spawn', ({ bonus }) => {
        this.bonuses.spawn(bonus);
      })
      .on('bonus_remove', ({ id, pickerId }) => {
        // If we're the picker, take possession of the power-up (replacing any held one).
        if (pickerId === this.myId) {
          const kind = this.bonuses.kindOf(id);
          if (kind) {
            this.heldBonus = kind;
            this.sound.play('sfx_join', { volume: 0.4 });
          }
        }
        this.bonuses.remove(id);
        this.requestedPickups.delete(id);
      })
      .on('bonus_teleport', ({ id, x, y }) => {
        if (id === this.myId) {
          this.ship.setPosition(x, y).setVelocity(0, 0).setAngularVelocity(0);
          this.endStun();
          this.cameras.main.centerOn(x, y);
          this.cameras.main.flash(300, 80, 180, 255);
          this.invincibleUntil = this.time.now + BONUS_TELEPORT_INVINCIBLE_MS;
          startBlink(this, this.ship, BONUS_TELEPORT_INVINCIBLE_MS);
        } else {
          this.remoteShips.setWorld(id, x, y);
        }
      })
      .on('player_effect', ({ id, kind, ms }) => {
        // A remote ship (bot or human) used a power-up — show it on their sprite.
        if (id !== this.myId) this.remoteShips.showEffect(id, kind, ms);
      })
      .on('player_die', ({ id }) => {
        const sprite = this.remoteShips.get(id);
        if (sprite) {
          showExplosion(this, sprite.x, sprite.y);
          sprite.setVisible(false);
        }
      })
      .on('player_respawn', ({ id, x, y, level }) => {
        if (id === this.myId) {
          this.ship.setPosition(x, y).setAngle(0).setVelocity(0, 0).setAngularVelocity(0).setVisible(true);
          this.endStun();
          this.cameras.main.centerOn(x, y);
          this.cameras.main.flash(400, 0, 180, 80);
          this.myLevel       = level;
          this.myMaxHp       = maxHpForLevel(level);
          this.myHp          = this.myMaxHp;
          this.myXp          = 0;
          this.lastDamagedBy = null;
          this.applyShipScale();
          this.lasers.refill();
          this.isDead = false;
          this.invincibleUntil = this.time.now + INVINCIBLE_MS;
          startBlink(this, this.ship);
        } else {
          this.remoteShips.respawn(id, x, y, level, this.ship.x, this.ship.y);
        }
      })
      .on('player_hit', ({ id, damage, shooterId }) => {
        if (id === this.myId && !this.isDead && this.time.now >= this.invincibleUntil) {
          if (!this.consumeShield()) {
            this.myHp          = Math.max(0, this.myHp - damage);
            this.lastDamagedBy = shooterId;
            this.cameras.main.shake(40, 0.002);
            if (this.myHp <= 0) this.startDeathSequence();
          }
        } else if (id !== this.myId) {
          const sprite = this.remoteShips.get(id);
          if (sprite?.visible) showLaserHit(this, sprite.x, sprite.y);
          this.remoteShips.applyDamage(id, damage);
        }
      })
      .on('xp_update', ({ xp, xpMax }) => {
        this.myXp    = xp;
        this.myXpMax = xpMax;
      })
      .on('leaderboard', ({ top, rank, score, total }) => {
        this.hud.setLeaderboard(top, rank, score, total);
      })
      .on('player_level_up', ({ id, level }) => {
        if (id === this.myId) {
          this.myLevel = level;
          this.myMaxHp = maxHpForLevel(level);
          this.myHp    = this.myMaxHp;
          this.applyShipScale();
          showLevelUpEffect(this, level);
        } else {
          this.remoteShips.levelUp(id, level);
        }
      })
      .on('player_rename', ({ id, name }) => {
        if (id === this.myId) this.myNameLabel.setText(name);
        else this.remoteShips.rename(id, name);
      })
      .on('player_leave', ({ id }) => {
        this.remoteShips.remove(id);
      })
      .onDisconnect(() => {
        this.hud.setStatus('Disconnected', '#ff4444');
      });
  }

  // ── Gameplay ───────────────────────────────────────────────────────────────

  private handleInput(): void {
    const { left, right, up } = this.cursors;
    if (left.isDown)       this.ship.setAngularVelocity(-PLAYER_ROTATION_SPEED);
    else if (right.isDown) this.ship.setAngularVelocity(PLAYER_ROTATION_SPEED);
    else                   this.ship.setAngularVelocity(0);

    // Boost: hold CTRL while thrusting to fly at BOOST_SPEED_MULT× thrust speed
    // until the gauge runs dry. Lift the velocity cap so the burst isn't clamped.
    // A new burst can only start once the gauge has refilled to BOOST_MIN_CHARGE,
    // but an in-progress burst (boostEngaged) keeps draining down to empty.
    const wantBoost = this.ctrlKey.isDown && up.isDown && this.boostCharge > 0;
    this.boostEngaged = wantBoost && (this.boostEngaged || this.boostCharge >= BOOST_MIN_CHARGE);
    this.boosting = this.boostEngaged;
    const speed = this.boosting ? PLAYER_THRUST_SPEED * BOOST_SPEED_MULT : PLAYER_THRUST_SPEED;
    this.ship.setMaxVelocity(this.boosting ? PLAYER_THRUST_SPEED * BOOST_SPEED_MULT : PLAYER_SPEED);

    if (up.isDown) {
      this.physics.velocityFromRotation(this.ship.rotation - Math.PI / 2, speed, this.ship.body!.velocity);
    } else {
      this.ship.setAcceleration(0);
    }
  }

  private checkCollisions(time: number): void {
    if (time < this.invincibleUntil) return;
    if (time - this.lastDamageTime < DAMAGE_COOLDOWN_MS) return;

    const myRadius = COLLISION_RADIUS * shipScaleForLevel(this.myLevel);
    for (const [id, sprite] of this.remoteShips.entries()) {
      if (!sprite.visible) continue;
      const theirRadius = COLLISION_RADIUS * shipScaleForLevel(this.remoteShips.levelOf(id));
      if (Phaser.Math.Distance.Between(this.ship.x, this.ship.y, sprite.x, sprite.y) < myRadius + theirRadius) {
        this.applyKnockback(sprite.x, sprite.y, time);
        // Bounce the other ship too: humans bounce themselves (their client
        // detects the same overlap), bots are knocked back server-side.
        this.network.send({ type: 'collide', targetId: id });
        this.takeDamage(DAMAGE_PER_HIT, id, time);
        return;
      }
    }
  }

  private takeDamage(amount: number, sourceId: number, time: number): void {
    this.lastDamageTime = time;
    if (this.consumeShield()) return;
    this.lastDamagedBy  = sourceId;
    this.myHp = Math.max(0, this.myHp - amount);
    this.cameras.main.shake(60, 0.003);
    if (this.myHp <= 0) this.startDeathSequence();
  }

  /** A shield hit was available: absorb one incoming damage event. Returns true
   *  if the hit was blocked (no HP lost). The shield stacks with every other bonus. */
  private consumeShield(): boolean {
    if (this.shieldHits <= 0) return false;
    this.shieldHits--;
    showShieldBlock(this, this.ship.x, this.ship.y, this.ship.displayWidth * 0.7);
    this.sound.play('sfx_laser', { volume: 0.25 });
    return true;
  }

  /** Pinball bounce: launch the ship away from the impact at 2× speed while
   *  spinning, and lock out control for KNOCKBACK_STUN_MS. */
  private applyKnockback(fromX: number, fromY: number, time: number): void {
    const away  = Math.atan2(this.ship.y - fromY, this.ship.x - fromX);
    const speed = KNOCKBACK_SPEED_MULT * PLAYER_SPEED;
    this.ship.setMaxVelocity(speed);   // lift the normal cap so the launch isn't clamped
    this.physics.velocityFromRotation(away, speed, this.ship.body!.velocity);
    this.ship.setAngularVelocity(Math.random() < 0.5 ? -KNOCKBACK_SPIN_DEG : KNOCKBACK_SPIN_DEG);
    this.stunnedUntil = time + KNOCKBACK_STUN_MS;
    this.sound.play('sfx_join', { volume: 0.2 });
  }

  /** End the stun: stop the spin and restore the normal speed cap. */
  private endStun(): void {
    this.stunnedUntil = 0;
    this.ship.setAngularVelocity(0);
    this.ship.setMaxVelocity(PLAYER_SPEED);
  }

  /** Incoming bot laser confirmed contact (LaserSystem already checked guards). */
  private applyIncomingLaser(amount: number, shooterId: number | null): void {
    if (this.consumeShield()) return;
    this.myHp = Math.max(0, this.myHp - amount);
    this.lastDamagedBy = shooterId;
    this.cameras.main.shake(40, 0.002);
    if (this.myHp <= 0) this.startDeathSequence();
  }

  private startDeathSequence(): void {
    this.isDead = true;
    this.endStun();
    this.lasers.clearAll();
    // Lose all power-ups on death.
    this.heldBonus  = null;
    this.shieldHits = 0;
    this.lasers.deactivateMega();
    this.shieldAura.setVisible(false);
    showExplosion(this, this.ship.x, this.ship.y);
    this.cameras.main.shake(300, 0.012);
    this.sound.play('sfx_lose', { volume: 0.5 });
    this.ship.setVisible(false).setVelocity(0, 0).setAngularVelocity(0);
    this.network.send({ type: 'die', killedBy: this.lastDamagedBy ?? undefined });
    showDeathOverlay(this, () => this.network.send({ type: 'respawn' }));
  }

  private updateThruster(): void {
    const isThrusting = !this.isDead && this.time.now >= this.stunnedUntil && this.cursors.up.isDown;
    this.thruster.setVisible(isThrusting);
    if (!isThrusting) return;
    const s         = shipScaleForLevel(this.myLevel);
    const eo        = ENGINE_OFFSET * s;
    const backAngle = this.ship.rotation + Math.PI / 2;
    this.thruster.setPosition(this.ship.x + Math.cos(backAngle) * eo, this.ship.y + Math.sin(backAngle) * eo);
    this.thruster.setRotation(this.ship.rotation);
    // A longer, brighter flame while boosting.
    this.thruster.setScale(0.55 * s * (this.boosting ? 1.7 : 1));
  }

  private applyShipScale(): void {
    this.ship.setScale(shipSpriteScale(this.myLevel));
    this.thruster.setScale(0.55 * shipScaleForLevel(this.myLevel));
  }

  /** Clear the shared HP-bar Graphics, draw the local ship's bar + label, then remotes'. */
  private updateLabels(): void {
    const g = this.remoteShips.healthBars;
    g.clear();
    if (this.isDead || !this.ship.visible) {
      this.myNameLabel.setVisible(false);
    } else {
      const nameY = drawHpBar(g, this.ship.x, this.ship.y - this.ship.displayHeight / 2, this.myHp, this.myMaxHp);
      this.myNameLabel.setVisible(true).setPosition(this.ship.x, nameY);
    }
    this.remoteShips.drawLabels(this.ship.x, this.ship.y);
  }

  private sendPosition(time: number): void {
    if (!this.network.connected || time - this.lastSent < SEND_RATE_MS) return;
    this.lastSent = time;
    // Send wrapped coords so the server keeps canonical positions in [0, WORLD).
    this.network.send({
      type:  'move',
      x:     Math.round(wrap(this.ship.x, WORLD_WIDTH)),
      y:     Math.round(wrap(this.ship.y, WORLD_HEIGHT)),
      angle: Math.round(this.ship.angle),
    });
  }

  // ── Bonuses ──────────────────────────────────────────────────────────────────

  /** Each frame: claim any bonus the ship is touching (server decides who wins). */
  private checkBonusPickup(): void {
    const radius = COLLISION_RADIUS * shipScaleForLevel(this.myLevel) + BONUS_SIZE_PX / 2 + BONUS_PICKUP_PAD;
    const id = this.bonuses.firstOverlapping(this.ship.x, this.ship.y, radius);
    if (id !== null && !this.requestedPickups.has(id)) {
      this.requestedPickups.add(id);
      this.network.send({ type: 'bonus_pickup', id });
    }
  }

  /** Left-Shift: consume the held bonus and apply its effect. */
  private activateHeldBonus(): void {
    if (this.isDead || !this.heldBonus) return;
    const kind = this.heldBonus;
    this.heldBonus = null;
    const now = this.time.now;

    switch (kind) {
      case 'fix':
        this.myHp = this.myMaxHp;
        this.cameras.main.flash(250, 80, 220, 80);
        break;
      case 'invincible':
        this.invincibleUntil = now + BONUS_INVINCIBLE_MS;
        startBlink(this, this.ship, BONUS_INVINCIBLE_MS);
        this.network.send({ type: 'notify_effect', kind: 'invincible', ms: BONUS_INVINCIBLE_MS });
        break;
      case 'mega_weapon':
        this.lasers.activateMega(BONUS_MEGA_MS);
        this.network.send({ type: 'notify_effect', kind: 'mega_weapon', ms: BONUS_MEGA_MS });
        break;
      case 'shield':
        this.shieldHits = BONUS_SHIELD_HITS;   // stacks with whatever else is active
        this.network.send({ type: 'notify_effect', kind: 'shield', ms: BONUS_SHIELD_VISUAL_MS });
        break;
      case 'teleport':
        // The server picks the least-crowded destination, then replies with bonus_teleport.
        this.network.send({ type: 'use_teleport' });
        break;
    }
    this.sound.play('sfx_join', { volume: 0.5 });
  }

  /** Pulse the shield ring around the ship while it has hits left. */
  private updateShieldAura(): void {
    if (this.shieldHits > 0 && !this.isDead && this.ship.visible) {
      this.shieldAura
        .setRadius(this.ship.displayWidth * 0.7)
        .setPosition(this.ship.x, this.ship.y)
        .setVisible(true)
        .setAlpha(0.35 + 0.3 * Math.abs(Math.sin(this.time.now / 200)));
    } else {
      this.shieldAura.setVisible(false);
    }
  }

  private updateBonusHud(): void {
    this.hud.setHeldBonus(this.heldBonus);
    const now = this.time.now;
    const parts: string[] = [];
    if (this.shieldHits > 0)         parts.push(`SHIELD x${this.shieldHits}`);
    if (now < this.invincibleUntil)  parts.push(`INVUL ${Math.ceil((this.invincibleUntil - now) / 1000)}s`);
    if (this.lasers.isMega())        parts.push(`MEGA ${Math.ceil(this.lasers.megaRemainingMs() / 1000)}s`);
    this.hud.setEffects(parts.join('   '));
  }
}
