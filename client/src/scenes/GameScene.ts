import Phaser from 'phaser';
import { Network } from '../network/Network';
import {
  WORLD_WIDTH, WORLD_HEIGHT,
  PLAYER_SPEED, PLAYER_ROTATION_SPEED, PLAYER_THRUST_SPEED, SEND_RATE_MS,
  SHIP_DRAG, BRAKE_DRAG, inSafeZone,
  BOOST_SPEED_MULT, BOOST_DURATION_MS, BOOST_REGEN_MS, BOOST_MIN_CHARGE,
  GAME_SPEED_LEVEL, gameSpeedMult,
  COLLISION_RADIUS, BASE_HP, DAMAGE_PER_HIT, DAMAGE_COOLDOWN_MS,
  KNOCKBACK_STUN_MS, KNOCKBACK_SPEED_MULT, KNOCKBACK_SPIN_DEG,
  LASER_MAX_RANGE, XP_TO_LEVEL,
  BONUS_PICKUP_PAD, BONUS_SIZE_PX, BONUS_INVINCIBLE_MS, BONUS_MEGA_MS,
  BONUS_SHIELD_HITS, BONUS_TELEPORT_INVINCIBLE_MS, BONUS_SHIELD_VISUAL_MS,
} from '@shared/constants';
import type { BonusType } from '@shared/types';
import { shipClass, SUPPORT_HEAL_RANGE, type ShipClassId } from '@shared/classes';
import { shipKey, ENGINE_OFFSET, INVINCIBLE_MS } from '../game/ui-constants';
import { shipScaleForLevel, shipSpriteScale, maxHpForLevel } from '../game/scale';
import { wrap, nearestImage } from '../game/torus';
import { drawHpBar } from '../game/healthbar';
import { showExplosion, showLaserHit, showLevelUpEffect, startBlink, showDeathOverlay, showShieldBlock } from '../game/effects';
import { Starfield } from '../game/Starfield';
import { SafeZone } from '../game/SafeZone';
import { Radar } from '../game/Radar';
import { Hud } from '../game/Hud';
import { RemoteShips } from '../game/RemoteShips';
import { LaserSystem } from '../game/LaserSystem';
import { BonusSystem } from '../game/BonusSystem';
import { InvitePopup } from '../game/InvitePopup';

/**
 * The game loop orchestrator. Owns the local player's state and ship, wires the
 * network handlers, and delegates rendering subsystems to dedicated modules in
 * `client/src/game/` (starfield, radar globe, HUD, remote ships, lasers, effects).
 */
export class GameScene extends Phaser.Scene {
  private network!: Network;
  private starfield!:   Starfield;
  private safeZone!:    SafeZone;
  private radar!:       Radar;
  private hud!:         Hud;
  private remoteShips!: RemoteShips;
  private lasers!:      LaserSystem;
  private bonuses!:     BonusSystem;
  private invitePopup!: InvitePopup;

  private myId: number | null = null;
  private ship!:        Phaser.Physics.Arcade.Image;
  private thruster!:    Phaser.GameObjects.Sprite;
  private myNameLabel!: Phaser.GameObjects.Text;
  private shieldAura!:  Phaser.GameObjects.Arc;
  private cursors!:     Phaser.Types.Input.Keyboard.CursorKeys;
  // WASD (QWERTY) / ZQSD (AZERTY) movement keys, registered alongside the arrows.
  // Both layouts are covered: up = W|Z, left = A|Q, down = S, right = D.
  private wasd!:        Record<'W' | 'A' | 'S' | 'D' | 'Z' | 'Q', Phaser.Input.Keyboard.Key>;
  private spaceKey!:    Phaser.Input.Keyboard.Key;
  private shiftKey!:    Phaser.Input.Keyboard.Key;
  private ctrlKey!:     Phaser.Input.Keyboard.Key;
  // Steering source: 'keys' = LEFT/RIGHT arrows rotate; 'mouse' = ship turns to
  // face the cursor. Pressing an arrow switches to 'keys'; moving the mouse
  // switches to 'mouse'. Whichever was used last wins until the other is used.
  private steerMode: 'keys' | 'mouse' = 'keys';

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
  // True while the local ship is inside a pole safe zone (refresh each frame):
  // no firing, no collisions, no incoming damage.
  private inSafe          = false;
  private invincibleUntil = 0;
  private stunnedUntil    = 0;
  private lastSent        = 0;
  private lastDamageTime  = 0;
  private lastDamagedBy: number | null = null;
  private myLevel = 1;
  private myTeamId = 0;
  private myName   = '';
  private myClass: ShipClassId = 'normal';
  // Global game-speed multiplier (baseline 1.0); overwritten from the server's
  // `init` (env GAME_SPEED). Scales movement + rotation on top of class levers.
  private speedMult = gameSpeedMult(GAME_SPEED_LEVEL);
  // While a team-invite popup is up the invitee is frozen & invincible (cannot
  // play, be hit, or use bonuses) until they answer (10 s timeout).
  private inviteFreeze = false;
  // Teammate chosen on the start screen → invite is sent once we spawn.
  private pendingInviteTarget: number | null = null;
  private myHp    = BASE_HP;
  private myMaxHp = BASE_HP;
  private myXp    = 0;
  private myXpMax = XP_TO_LEVEL;

  constructor() { super('Game'); }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  init(data: { name?: string; cls?: ShipClassId; inviteTargetId?: number }): void {
    this.playerName = (data?.name ?? '').trim();
    this.myClass    = data?.cls ?? 'normal';
    this.pendingInviteTarget = data?.inviteTargetId ?? null;
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
    this.myTeamId = 0;
    this.inviteFreeze = false;
    this.myMaxHp = maxHpForLevel(1, this.myClass);
    this.myHp    = this.myMaxHp;
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
    this.safeZone    = new SafeZone(this);
    this.buildPlayer();
    this.remoteShips = new RemoteShips(this);
    this.bonuses     = new BonusSystem(this);
    this.radar       = new Radar(this);
    this.hud         = new Hud(this);
    this.lasers      = new LaserSystem(this, {
      ship:            () => this.ship,
      level:           () => this.myLevel,
      cls:             () => this.myClass,
      isDead:          () => this.isDead,
      invincibleUntil: () => this.invincibleUntil,
      remoteShips:     this.remoteShips,
      speedMult:       () => this.speedMult,
      onHitRemote:     (id) => this.network.send({ type: 'hit', targetId: id }),
      hitSelf:         (amount, shooterId) => this.applyIncomingLaser(amount, shooterId),
      onFire:          (bolts) => this.network.send({
        type: 'fire',
        // Wrap to [0, WORLD) like sendPosition; receivers place each bolt at the
        // torus image nearest them (nearestImage in the laser_spawn handler).
        bolts: bolts.map(b => ({
          x:  Math.round(wrap(b.x, WORLD_WIDTH)),
          y:  Math.round(wrap(b.y, WORLD_HEIGHT)),
          vx: Math.round(b.vx),
          vy: Math.round(b.vy),
        })),
      }),
    });
    this.bindKeys();

    // In-game confirmation popup for an incoming team invite (the request itself
    // is initiated on the start screen). Answering keeps a 2 s invuln grace; a
    // 10 s timeout closes the popup with none.
    this.invitePopup = new InvitePopup({
      onRespond: (fromId, ok) => { this.network.send({ type: 'team_invite_respond', fromId, accept: ok }); this.endInviteFreeze(true); },
      onExpire:  (fromId)     => { this.network.send({ type: 'team_invite_respond', fromId, accept: false }); this.endInviteFreeze(false); },
    });

    // No camera bounds: the ship roams in a continuous (un-wrapped) coordinate
    // space and the camera always centres it, so crossing the world seam is
    // seamless. Everything else is rendered relative to the ship (torus world).
    this.cameras.main.startFollow(this.ship, true, 1, 1);

    this.scale.on('resize', this.onResize, this);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.scale.off('resize', this.onResize, this);
      this.invitePopup.destroy();
    });

    await this.connectNetwork();
  }

  update(time: number, delta: number): void {
    // Place every remote ship at its torus image nearest us, and scroll the
    // infinite starfield, before anything reads world positions this frame.
    this.remoteShips.updatePositions(this.ship.x, this.ship.y);
    this.starfield.scroll(this.ship.x, this.ship.y);
    this.safeZone.draw(this.ship.x, this.ship.y, time);
    this.bonuses.reposition(this.ship.x, this.ship.y);
    this.boosting = false;   // handleInput re-arms it when CTRL+thrust is held
    // Inside a pole refuge: can't fire, collide, or be hit from outside.
    this.inSafe = this.inMySafeZone();
    if (this.inviteFreeze && !this.isDead) {
      // Deciding on a team invite: hold still, no control/collision/fire/bonus.
      this.ship.setVelocity(0, 0).setAngularVelocity(0);
    } else if (!this.isDead) {
      // While stunned (post-collision) the ship flies & spins on its own — no
      // control, no firing, no new collisions — until it recovers.
      if (this.stunnedUntil > 0 && time >= this.stunnedUntil) this.endStun();
      const stunned = time < this.stunnedUntil;
      if (!stunned) {
        this.handleInput(delta);
        if (!this.inSafe) this.checkCollisions(time);
      }
      const fireHeld = this.spaceKey.isDown || this.input.activePointer.leftButtonDown();
      this.lasers.shootIfReady(time, fireHeld && !stunned && !this.inSafe);
      this.checkBonusPickup();
      this.sendPosition(time);
    }
    // Boost gauge: drains over BOOST_DURATION_MS while boosting, else refills
    // over BOOST_REGEN_MS (regenerates even while dead/stunned). The class scales
    // both: boostDurationMult lengthens a full burst, boostRegenMult speeds refill.
    const cls = shipClass(this.myClass);
    if (this.boosting) this.boostCharge = Math.max(0, this.boostCharge - delta / (BOOST_DURATION_MS * cls.boostDurationMult));
    else               this.boostCharge = Math.min(1, this.boostCharge + delta * cls.boostRegenMult / BOOST_REGEN_MS);

    // Passive HP regen: the class's own regen plus any nearby teammate Support.
    this.regenHealth(delta);

    this.lasers.update(delta);
    this.updateThruster();
    this.updateShieldAura();
    this.updateLabels();
    this.radar.draw(
      this.ship.x, this.ship.y, this.remoteShips.entries(),
      (id) => this.remoteShips.isTeammate(id),
      (id) => this.remoteShips.isBoss(id),
    );

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
      .setDamping(true).setDrag(SHIP_DRAG).setMaxVelocity(PLAYER_SPEED)
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
    this.wasd     = this.input.keyboard!.addKeys('W,A,S,D,Z,Q') as typeof this.wasd;
    this.spaceKey = this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.SPACE);
    this.shiftKey = this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.SHIFT);
    this.ctrlKey  = this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.CTRL);
    this.shiftKey.on('down', () => this.activateHeldBonus());
    // Moving the mouse hands steering to the cursor (until an arrow is pressed).
    this.input.on('pointermove', () => { this.steerMode = 'mouse'; });
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
      .on('init', ({ id, players, bonuses, gameSpeed }) => {
        this.myId = id;
        this.speedMult = gameSpeedMult(gameSpeed);
        this.ship.setMaxVelocity(PLAYER_SPEED * this.speedMult);
        const me = players.find(p => p.id === id);
        if (me) {
          this.ship.setTexture(shipKey(me.ship)).setPosition(me.x, me.y);
          this.cameras.main.centerOn(me.x, me.y);
          this.myName = this.playerName || me.name;
          this.applyMyLabelStyle();
        }
        players.forEach(p => { if (p.id !== id) this.remoteShips.spawn(p); });
        bonuses.forEach(b => this.bonuses.spawn(b));
        if (this.playerName) this.network.send({ type: 'set_name', name: this.playerName });
        // Tell the server our chosen class (default 'normal' needs no announce).
        if (this.myClass !== 'normal') this.network.send({ type: 'set_class', cls: this.myClass });
        // Fire the team invite chosen on the start screen (target confirms in-game).
        if (this.pendingInviteTarget !== null && this.pendingInviteTarget !== id) {
          this.network.send({ type: 'team_invite_send', toId: this.pendingInviteTarget });
        }
        this.pendingInviteTarget = null;
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
        // Bots & remote players are capped at LASER_MAX_RANGE (like the local
        // player); the boss is exempt — it uses its profile's (much longer)
        // shootRange so its volleys actually reach distant targets.
        const baseRange = this.remoteShips.bossShootRangeOf(shooterId) ?? LASER_MAX_RANGE;
        // Spawn in our continuous frame so it appears next to the firing ship.
        this.lasers.spawnBolt(
          nearestImage(x, this.ship.x, WORLD_WIDTH),
          nearestImage(y, this.ship.y, WORLD_HEIGHT),
          // Bolt velocity already arrives game-speed-scaled by the shooter; scale
          // the range cap too so it travels proportionally farther (not longer-lived).
          vx, vy, rotation, baseRange * this.speedMult, true, shooterId,
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
          this.myMaxHp       = maxHpForLevel(level, this.myClass);
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
        if (id === this.myId && !this.isDead && !this.inviteFreeze && !this.inSafe && this.time.now >= this.invincibleUntil) {
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
          this.myMaxHp = maxHpForLevel(level, this.myClass);
          this.myHp    = this.myMaxHp;
          this.applyShipScale();
          showLevelUpEffect(this, level);
        } else {
          this.remoteShips.levelUp(id, level);
        }
      })
      .on('player_rename', ({ id, name }) => {
        if (id === this.myId) { this.myName = name; this.applyMyLabelStyle(); }
        else this.remoteShips.rename(id, name);
      })
      .on('player_class', ({ id, cls }) => {
        // A remote ship picked/changed its class → restyle its label + HP.
        if (id !== this.myId) this.remoteShips.setClass(id, cls);
      })
      .on('team_set', ({ updates }) => {
        for (const u of updates) {
          if (u.id === this.myId) {
            this.myTeamId = u.teamId;
            this.remoteShips.setLocalTeam(u.teamId);   // restyle every teammate label
            this.applyMyLabelStyle();
          } else {
            this.remoteShips.setTeam(u.id, u.teamId);
          }
        }
      })
      .on('team_invite', ({ fromId, fromName }) => {
        this.invitePopup.show(fromId, fromName);
        this.beginInviteFreeze();
        this.sound.play('sfx_join', { volume: 0.4 });
      })
      .on('player_leave', ({ id }) => {
        this.remoteShips.remove(id);
      })
      .onDisconnect(() => {
        this.hud.setStatus('Disconnected', '#ff4444');
      });
  }

  // ── Gameplay ───────────────────────────────────────────────────────────────

  /** Combined directional input: arrow keys OR WASD (QWERTY) / ZQSD (AZERTY). */
  private moveInput() {
    const c = this.cursors, k = this.wasd;
    return {
      up:    c.up.isDown    || k.W.isDown || k.Z.isDown,
      down:  c.down.isDown  || k.S.isDown,
      left:  c.left.isDown  || k.A.isDown || k.Q.isDown,
      right: c.right.isDown || k.D.isDown,
    };
  }

  private handleInput(delta: number): void {
    const { left, right, up, down } = this.moveInput();
    const cls    = shipClass(this.myClass);
    const rotate = PLAYER_ROTATION_SPEED * cls.rotationMult * this.speedMult; // class manoeuvrability × game speed

    // Pressing a turn key takes steering back from the mouse.
    if (left || right) this.steerMode = 'keys';

    if (this.steerMode === 'mouse') {
      // Turn toward the cursor at the same rotation speed as the arrows (no snap).
      const ptr = this.input.activePointer;
      // Ship image points up at rotation 0, so its facing = atan2(dy,dx) + π/2.
      const target  = Math.atan2(ptr.worldY - this.ship.y, ptr.worldX - this.ship.x) + Math.PI / 2;
      const diff    = Phaser.Math.Angle.Wrap(target - this.ship.rotation);
      const maxStep = Phaser.Math.DegToRad(rotate) * delta / 1000;
      if (Math.abs(diff) <= maxStep) {
        this.ship.setAngularVelocity(0).setRotation(target);
      } else {
        this.ship.setAngularVelocity(diff > 0 ? rotate : -rotate);
      }
    } else if (left)  this.ship.setAngularVelocity(-rotate);
    else if (right)   this.ship.setAngularVelocity(rotate);
    else              this.ship.setAngularVelocity(0);

    // Brake: holding DOWN (without thrusting) swaps in a much stronger damping so
    // the ship decelerates to a stop. Otherwise coast on the gentle default drag.
    this.ship.setDrag(down && !up ? BRAKE_DRAG : SHIP_DRAG);

    // Boost: hold CTRL while thrusting to fly at BOOST_SPEED_MULT× thrust speed
    // until the gauge runs dry. Lift the velocity cap so the burst isn't clamped.
    // A new burst can only start once the gauge has refilled to BOOST_MIN_CHARGE,
    // but an in-progress burst (boostEngaged) keeps draining down to empty.
    const wantBoost = this.ctrlKey.isDown && up && this.boostCharge > 0;
    this.boostEngaged = wantBoost && (this.boostEngaged || this.boostCharge >= BOOST_MIN_CHARGE);
    this.boosting = this.boostEngaged;
    const boostSpeed = PLAYER_THRUST_SPEED * BOOST_SPEED_MULT * cls.boostSpeedMult * this.speedMult;
    const speed = this.boosting ? boostSpeed : PLAYER_THRUST_SPEED * this.speedMult;
    this.ship.setMaxVelocity(this.boosting ? boostSpeed : PLAYER_SPEED * this.speedMult);

    // Keep momentum aligned with the ship's heading so turning also steers the
    // velocity vector (arcade feel: you always move where you point). While
    // thrusting, magnitude = thrust/boost speed; while coasting/braking we keep
    // the current speed and just re-point it. The knockback launch is exempt
    // because handleInput is skipped during the post-collision stun.
    const vel = this.ship.body!.velocity;
    const mag = up ? speed : vel.length();
    if (up || mag > 0) {
      this.physics.velocityFromRotation(this.ship.rotation - Math.PI / 2, mag, vel);
    }
    if (!up) this.ship.setAcceleration(0);
  }

  private checkCollisions(time: number): void {
    if (time < this.invincibleUntil) return;
    if (time - this.lastDamageTime < DAMAGE_COOLDOWN_MS) return;

    const myRadius = COLLISION_RADIUS * shipScaleForLevel(this.myLevel);
    for (const [id, sprite] of this.remoteShips.entries()) {
      if (!sprite.visible) continue;
      // A ship sheltering in a refuge can't be rammed.
      if (inSafeZone(wrap(sprite.x, WORLD_WIDTH), wrap(sprite.y, WORLD_HEIGHT))) continue;
      const theirRadius = COLLISION_RADIUS * this.remoteShips.collisionScaleOf(id);
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
    const speed = KNOCKBACK_SPEED_MULT * PLAYER_SPEED * this.speedMult;
    this.ship.setDrag(SHIP_DRAG);      // clear any brake drag so the launch decays normally
    this.ship.setMaxVelocity(speed);   // lift the normal cap so the launch isn't clamped
    this.physics.velocityFromRotation(away, speed, this.ship.body!.velocity);
    this.ship.setAngularVelocity(Math.random() < 0.5 ? -KNOCKBACK_SPIN_DEG : KNOCKBACK_SPIN_DEG);
    this.stunnedUntil = time + KNOCKBACK_STUN_MS;
    this.sound.play('sfx_join', { volume: 0.2 });
  }

  /** Is the local ship currently inside a pole refuge? (torus-aware, wrapped coords) */
  private inMySafeZone(): boolean {
    return inSafeZone(wrap(this.ship.x, WORLD_WIDTH), wrap(this.ship.y, WORLD_HEIGHT));
  }

  /** End the stun: stop the spin and restore the normal speed cap. */
  private endStun(): void {
    this.stunnedUntil = 0;
    this.ship.setAngularVelocity(0);
    this.ship.setMaxVelocity(PLAYER_SPEED * this.speedMult);
  }

  /** Incoming bot laser confirmed contact (LaserSystem already checked guards). */
  private applyIncomingLaser(amount: number, shooterId: number | null): void {
    if (this.inviteFreeze || this.inSafe) return;   // invincible while answering an invite / in a refuge
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
    const isThrusting = !this.isDead && !this.inviteFreeze && this.time.now >= this.stunnedUntil && this.moveInput().up;
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

  /** Label = class marker + pseudo. Teammates override to green-with-stars; solo
   *  players show their class colour (or the default gold for 'normal'). Mirrors
   *  RemoteShips.applyLabelStyle. */
  private applyMyLabelStyle(): void {
    const teamed = this.myTeamId !== 0;
    const cls    = shipClass(this.myClass);
    const marked = cls.marker ? `${cls.marker} ${this.myName}` : this.myName;
    this.myNameLabel
      .setText(teamed ? `⭐ ${marked} ⭐` : marked)
      .setColor(teamed ? '#33ff66' : cls.id !== 'normal' ? cls.color : '#ffee88');
  }

  /** Passive HP regen: the class's own `regenPerSec` plus the sum of every nearby
   *  teammate Support's `teamHealPerSec`. Client-side (human HP isn't server-tracked). */
  private regenHealth(delta: number): void {
    if (this.isDead || this.myHp >= this.myMaxHp) return;
    let perSec = shipClass(this.myClass).regenPerSec;
    if (this.myTeamId !== 0) {
      const rangeSq = SUPPORT_HEAL_RANGE * SUPPORT_HEAL_RANGE;
      for (const [id, sprite] of this.remoteShips.entries()) {
        if (!sprite.visible || !this.remoteShips.isTeammate(id)) continue;
        const heal = shipClass(this.remoteShips.classOf(id)).teamHealPerSec;
        if (heal <= 0) continue;
        const dx = sprite.x - this.ship.x, dy = sprite.y - this.ship.y;
        if (dx * dx + dy * dy <= rangeSq) perSec += heal;
      }
    }
    if (perSec > 0) this.myHp = Math.min(this.myMaxHp, this.myHp + perSec * delta / 1000);
  }

  /** A team invite arrived: freeze the ship and make it invincible while deciding. */
  private beginInviteFreeze(): void {
    this.inviteFreeze = true;
    this.ship.setVelocity(0, 0).setAngularVelocity(0);
  }

  /** Invite resolved. Answering keeps a 2 s invuln grace; a timeout grants none. */
  private endInviteFreeze(grace: boolean): void {
    if (!this.inviteFreeze) return;
    this.inviteFreeze = false;
    if (grace) {
      this.invincibleUntil = this.time.now + 2000;
      startBlink(this, this.ship, 2000);
    }
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
    if (this.isDead || this.inviteFreeze || !this.heldBonus) return;   // bonuses blocked while answering an invite
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
    if (this.inSafe)                 parts.push('⛨ REFUGE');
    if (this.shieldHits > 0)         parts.push(`SHIELD x${this.shieldHits}`);
    if (now < this.invincibleUntil)  parts.push(`INVUL ${Math.ceil((this.invincibleUntil - now) / 1000)}s`);
    if (this.lasers.isMega())        parts.push(`MEGA ${Math.ceil(this.lasers.megaRemainingMs() / 1000)}s`);
    this.hud.setEffects(parts.join('   '));
  }
}
