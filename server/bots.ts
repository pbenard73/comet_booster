import type { TemplatedApp } from 'uWebSockets.js';
import {
  WORLD_WIDTH, WORLD_HEIGHT, BASE_HP, HP_PER_LEVEL, SHIP_COUNT,
  botDifficultyMult, BOT_SHOOT_RANGE, BOT_SHOOT_COOLDOWN_MS, LASER_SPEED,
  KNOCKBACK_STUN_MS, KNOCKBACK_SPEED_MULT, KNOCKBACK_SPIN_DEG,
  SERVER_TICK_MS, gameSpeedMult,
  BONUS_INVINCIBLE_MS, BONUS_MEGA_MS, BONUS_MEGA_COOLDOWN_MS,
  BONUS_SHIELD_HITS, BONUS_TELEPORT_INVINCIBLE_MS,
  BOT_BONUS_SEEK_RANGE, BOT_POWERED_SPEED_MULT,
} from '../shared/constants.js';
import type { SpatialGrid } from './grid.js';
import { shipClass, SHIP_CLASS_ORDER, type ShipClassId } from '../shared/classes.js';

/** HP scales with level & class, matching the client's max-HP formula (for the HP bar). */
const maxHpForLevel = (level: number, cls: ShipClassId) =>
  Math.round((BASE_HP + (level - 1) * HP_PER_LEVEL) * shipClass(cls).maxHpMult);
import type { ServerMessage, BonusType } from '../shared/types.js';
import type { ServerPlayer } from './score.js';
import { GAME_SPEED_CONFIG } from './config.js';

const BOT_SPEED  = 200;  // px/s max
// Global game-speed multiplier (env GAME_SPEED, baseline 40 → 1.0): scales both
// bot translation speed and turn rate so humans and bots share one speed knob.
const GAME_SPEED = gameSpeedMult(GAME_SPEED_CONFIG);
const BOT_TURN_STEP = 3 * GAME_SPEED;  // max deg/tick the bot rotates toward its target
const RESPAWN_MS = 3000;
const SHOOT_CONE_DEG = 18;                                  // only fire when target is this close to dead-ahead
const COS_SHOOT_CONE = Math.cos(SHOOT_CONE_DEG * Math.PI / 180);

const BOT_SEEK_SQ = BOT_BONUS_SEEK_RANGE * BOT_BONUS_SEEK_RANGE;

type BotShot = { shooterId: number; targetId: number; x: number; y: number; vx: number; vy: number };
type BonusPos = { x: number; y: number };

interface Bot {
  id:       number;
  name:     string;
  ship:     number;   // fixed sprite index — stable across all clients
  cls:      ShipClassId; // fixed RPG class — gives the arena class variety + marker
  level:    number;   // fixed at spawn — gives the leaderboard meaningful variety
  x:        number;
  y:        number;
  angle:    number;
  vx:       number;
  vy:       number;
  targetX:  number;
  targetY:  number;
  hp:       number;
  dead:     boolean;
  lastShot: number;
  stunnedUntil: number;  // while > now: knocked back, flying free, no steering/shooting
  spin:     number;      // deg/s applied to angle during the stun
  // Bonus effects (a bot uses a bonus immediately on pickup — no holding):
  invincibleUntil: number; // while > now: takes no damage
  shieldHits:      number;  // hits absorbed before damage resumes
  megaUntil:       number;  // while > now: fires on the short mega cooldown
}

const BOT_NAMES = [
  'Nova', 'Razor', 'Vortex', 'Comet', 'Blaze', 'Striker', 'Falcon', 'Viper',
  'Ghost', 'Rogue', 'Apex', 'Drift', 'Onyx', 'Pulse', 'Quasar', 'Saber',
  'Talon', 'Zenith', 'Echo', 'Frost', 'Hydra', 'Specter', 'Titan', 'Wraith',
];
function botName(): string {
  return BOT_NAMES[Math.floor(Math.random() * BOT_NAMES.length)] + Math.floor(10 + Math.random() * 90);
}
// Skewed toward low levels so a human can realistically climb the ranking.
function botLevel(): number {
  return 1 + Math.floor(Math.random() ** 2 * 18);
}
// Half the bots stay 'normal'; the rest pick a random role, so the arena shows a
// mix of class markers without flooding it with exotic builds.
function botClass(): ShipClassId {
  if (Math.random() < 0.5) return 'normal';
  return SHIP_CLASS_ORDER[1 + Math.floor(Math.random() * (SHIP_CLASS_ORDER.length - 1))];
}

export interface BotController {
  /** Advance every bot one step (steer/shoot via `grid`, seek bonuses via
   *  `bonuses`), writing new positions into the shared players map; returns the
   *  laser shots fired this tick. `isBoss` ids are never targeted (bots ignore the boss). */
  tick(now: number, grid: SpatialGrid, bonuses: BonusPos[], isBoss?: (id: number) => boolean): BotShot[];
  damageBot(id: number, damage: number, shooterId: number): void;
  knockBot(id: number, fromX: number, fromY: number): void;
  /** Apply a picked-up bonus's effect to a bot (used immediately, no holding).
   *  Teleport is handled by the caller via `teleportBot` (it needs world density). */
  applyBonus(id: number, kind: BonusType): void;
  teleportBot(id: number, x: number, y: number): void;
  isBotId(id: number): boolean;
}

function rndPos()    { return { x: Math.random() * WORLD_WIDTH,  y: Math.random() * WORLD_HEIGHT }; }
function rndTarget() { return { targetX: Math.random() * WORLD_WIDTH, targetY: Math.random() * WORLD_HEIGHT }; }
function wrap(v: number, max: number) { return ((v % max) + max) % max; }
/** Torus-shortest signed delta from a to b. */
function torusDelta(a: number, b: number, max: number) { return ((b - a + max * 1.5) % max) - max / 2; }

/** Turn toward (dx, dy) and integrate one step. `speedMult` boosts speed while powered. */
function steerBot(bot: Bot, dx: number, dy: number, speedMult: number): void {
  const dt = SERVER_TICK_MS / 1000;

  const desired = (Math.atan2(dy, dx) + Math.PI / 2) * 180 / Math.PI;
  const diff    = ((desired - bot.angle + 540) % 360) - 180;
  bot.angle    += Math.max(-BOT_TURN_STEP, Math.min(BOT_TURN_STEP, diff));
  bot.angle     = ((bot.angle + 540) % 360) - 180;

  const rotRad = (bot.angle - 90) * Math.PI / 180;
  const speed  = BOT_SPEED * speedMult * GAME_SPEED;
  bot.vx = bot.vx * 0.94 + Math.cos(rotRad) * speed * 0.06;
  bot.vy = bot.vy * 0.94 + Math.sin(rotRad) * speed * 0.06;

  bot.x = wrap(bot.x + bot.vx * dt, WORLD_WIDTH);
  bot.y = wrap(bot.y + bot.vy * dt, WORLD_HEIGHT);
}

export function startBots(
  app: TemplatedApp,
  players: Map<number, ServerPlayer>,
  allocateId: () => number,
  count: number,
  difficultyLevel: number,   // 1–100; mapped to a strength multiplier
  onBotKilled: (shooterId: number) => void,
  onBotDeath: (x: number, y: number) => void,
): BotController {
  const bots: Bot[] = [];
  const botIds          = new Set<number>();
  const difficulty      = botDifficultyMult(difficultyLevel);  // 0–1 strength multiplier
  // Shoot/detection range scales with the global game speed too (like ship + bolt
  // speed), so engagements stay proportional as the arena speeds up.
  const effectiveRange  = BOT_SHOOT_RANGE * difficulty * GAME_SPEED;
  const fullRange       = BOT_SHOOT_RANGE * GAME_SPEED;            // detection while powered (no difficulty handicap)
  const effectiveCooldown = difficulty > 0 ? BOT_SHOOT_COOLDOWN_MS / difficulty : Infinity;
  const shootRangeSq    = effectiveRange * effectiveRange;

  for (let i = 0; i < count; i++) {
    const id    = allocateId();
    const pos   = rndPos();
    const level = botLevel();
    const cls   = botClass();
    const bot: Bot = {
      id, ...pos,
      name:     botName(),
      ship:     Math.floor(Math.random() * SHIP_COUNT),
      cls,
      level,
      angle:    Math.random() * 360 - 180,
      vx: 0, vy: 0,
      ...rndTarget(),
      hp:       maxHpForLevel(level, cls),
      dead:     false,
      lastShot: Date.now() + Math.random() * BOT_SHOOT_COOLDOWN_MS,
      stunnedUntil: 0,
      spin:     0,
      invincibleUntil: 0,
      shieldHits:      0,
      megaUntil:       0,
    };
    bots.push(bot);
    botIds.add(id);
    players.set(id, { id, x: bot.x, y: bot.y, angle: bot.angle, dead: false, level: bot.level, xp: 0, name: bot.name, ship: bot.ship, cls: bot.cls, teamId: 0, bot: true });
  }

  for (const bot of bots) {
    app.publish('all', JSON.stringify({
      type: 'player_join',
      player: { id: bot.id, x: bot.x, y: bot.y, angle: bot.angle, level: bot.level, name: bot.name, ship: bot.ship, cls: bot.cls, bot: true },
    } as ServerMessage));
  }

  // Advance every bot one step — driven by the server's unified 20 Hz tick.
  function tick(now: number, grid: SpatialGrid, bonuses: BonusPos[], isBoss?: (id: number) => boolean): BotShot[] {
    const shots: BotShot[] = [];

    for (const bot of bots) {
      if (bot.dead) continue;

      // Knocked back: fly free with decaying velocity + spin, no steering/shooting.
      if (now < bot.stunnedUntil) {
        const dt = SERVER_TICK_MS / 1000;
        bot.vx *= 0.96;
        bot.vy *= 0.96;
        bot.x = wrap(bot.x + bot.vx * dt, WORLD_WIDTH);
        bot.y = wrap(bot.y + bot.vy * dt, WORLD_HEIGHT);
        bot.angle = ((bot.angle + bot.spin * dt + 540) % 360) - 180;
        const p = players.get(bot.id);
        if (p) { p.x = bot.x; p.y = bot.y; p.angle = bot.angle; }
        continue;
      }

      // A bot with an active bonus hunts harder: full detection range (ignoring
      // the difficulty handicap) and a movement boost, so the power-up is used
      // aggressively rather than passively held.
      const powered  = bot.megaUntil > now || bot.invincibleUntil > now;
      const detectSq = powered ? fullRange * fullRange : shootRangeSq;

      // Nearest live player within detection range — used both to aim (steer) and
      // to fire. The grid bounds the search to the cells around the bot. (Holder
      // object so the closure write survives control-flow narrowing.)
      const aim = { target: null as ServerPlayer | null, distSq: detectSq };
      grid.forEachNear(bot.x, bot.y, 1, (other) => {
        if (other.id === bot.id || other.dead || (isBoss && isBoss(other.id))) return;
        const dx = other.x - bot.x, dy = other.y - bot.y;
        const d2 = dx * dx + dy * dy;
        if (d2 < aim.distSq) { aim.distSq = d2; aim.target = other; }
      });
      const target = aim.target;

      // Steering destination: chase the enemy in range; otherwise go grab the
      // nearest bonus within seek range (so bots actively collect power-ups);
      // otherwise wander toward the random roam point.
      let dx: number, dy: number;
      if (target) {
        dx = target.x - bot.x;
        dy = target.y - bot.y;
      } else {
        let best = -1, bestSq = BOT_SEEK_SQ;
        for (let i = 0; i < bonuses.length; i++) {
          const bx = torusDelta(bot.x, bonuses[i].x, WORLD_WIDTH);
          const by = torusDelta(bot.y, bonuses[i].y, WORLD_HEIGHT);
          const d2 = bx * bx + by * by;
          if (d2 < bestSq) { bestSq = d2; best = i; }
        }
        if (best >= 0) {
          dx = torusDelta(bot.x, bonuses[best].x, WORLD_WIDTH);
          dy = torusDelta(bot.y, bonuses[best].y, WORLD_HEIGHT);
        } else {
          dx = bot.targetX - bot.x;
          dy = bot.targetY - bot.y;
          if (dx * dx + dy * dy < 400 * 400) {
            Object.assign(bot, rndTarget());
            dx = bot.targetX - bot.x;
            dy = bot.targetY - bot.y;
          }
        }
      }
      steerBot(bot, dx, dy, powered ? BOT_POWERED_SPEED_MULT : 1);

      const p = players.get(bot.id);
      if (p) { p.x = bot.x; p.y = bot.y; p.angle = bot.angle; }

      const cooldown = bot.megaUntil > now ? BONUS_MEGA_COOLDOWN_MS : effectiveCooldown;
      if (target && now >= bot.lastShot + cooldown) {
        // Fire straight out of the nose — but only when the target is within the
        // forward cone, so bots can't shoot sideways or backwards.
        const noseRad = (bot.angle - 90) * Math.PI / 180;
        const fx = Math.cos(noseRad), fy = Math.sin(noseRad);
        const dx = target.x - bot.x, dy = target.y - bot.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        if ((dx / dist) * fx + (dy / dist) * fy >= COS_SHOOT_CONE) {
          bot.lastShot = now;
          shots.push({
            shooterId: bot.id, targetId: target.id,
            x: Math.round(bot.x), y: Math.round(bot.y),
            vx: Math.round(fx * LASER_SPEED * GAME_SPEED),
            vy: Math.round(fy * LASER_SPEED * GAME_SPEED),
          });
        }
      }
    }

    return shots;
  }

  function damageBot(id: number, damage: number, shooterId: number): void {
    const bot = bots.find(b => b.id === id);
    if (!bot || bot.dead) return;

    // Bonus protection: invincibility ignores the hit; the shield absorbs one.
    if (Date.now() < bot.invincibleUntil) return;
    if (bot.shieldHits > 0) { bot.shieldHits--; return; }

    bot.hp -= damage;
    if (bot.hp > 0) return;

    bot.dead = true;
    const p = players.get(bot.id);
    if (p) p.dead = true;
    app.publish('all', JSON.stringify({ type: 'player_die', id: bot.id } as ServerMessage));
    onBotKilled(shooterId);
    onBotDeath(bot.x, bot.y);   // exploding ship may drop a bonus

    setTimeout(() => {
      const pos = rndPos();
      bot.x     = pos.x;
      bot.y     = pos.y;
      bot.angle = Math.random() * 360 - 180;
      bot.vx    = 0;
      bot.vy    = 0;
      bot.hp    = maxHpForLevel(bot.level, bot.cls);
      bot.dead  = false;
      bot.invincibleUntil = 0;
      bot.shieldHits      = 0;
      bot.megaUntil       = 0;
      Object.assign(bot, rndTarget());
      const pp = players.get(bot.id);
      if (pp) { pp.x = bot.x; pp.y = bot.y; pp.angle = bot.angle; pp.dead = false; pp.level = bot.level; }
      app.publish('all', JSON.stringify({
        type: 'player_respawn', id: bot.id,
        x: Math.round(bot.x), y: Math.round(bot.y), level: bot.level,
      } as ServerMessage));
    }, RESPAWN_MS);
  }

  /** Pinball bounce: launch a bot away from (fromX, fromY) at 2× speed, spinning
   *  and stunned, mirroring the local player's own knockback. */
  function knockBot(id: number, fromX: number, fromY: number): void {
    const bot = bots.find(b => b.id === id);
    if (!bot || bot.dead) return;
    // Torus-shortest direction from the impact point to the bot.
    let dx = bot.x - fromX; dx = ((dx + WORLD_WIDTH  * 1.5) % WORLD_WIDTH)  - WORLD_WIDTH  / 2;
    let dy = bot.y - fromY; dy = ((dy + WORLD_HEIGHT * 1.5) % WORLD_HEIGHT) - WORLD_HEIGHT / 2;
    const d = Math.hypot(dx, dy) || 1;
    const speed = KNOCKBACK_SPEED_MULT * BOT_SPEED * GAME_SPEED;
    bot.vx = (dx / d) * speed;
    bot.vy = (dy / d) * speed;
    bot.spin = (Math.random() < 0.5 ? -1 : 1) * KNOCKBACK_SPIN_DEG;
    bot.stunnedUntil = Date.now() + KNOCKBACK_STUN_MS;
  }

  /** Apply a bonus effect to a bot immediately (bots don't hold/aim power-ups). */
  function applyBonus(id: number, kind: BonusType): void {
    const bot = bots.find(b => b.id === id);
    if (!bot || bot.dead) return;
    const now = Date.now();
    switch (kind) {
      case 'fix':         bot.hp = maxHpForLevel(bot.level, bot.cls);        break;
      case 'invincible':  bot.invincibleUntil = now + BONUS_INVINCIBLE_MS;  break;
      case 'mega_weapon': bot.megaUntil       = now + BONUS_MEGA_MS;        break;
      case 'shield':      bot.shieldHits      = BONUS_SHIELD_HITS;          break;
      case 'teleport':    /* destination chosen by the caller via teleportBot */ break;
    }
  }

  /** Relocate a bot (teleport bonus) with a short post-jump invulnerability. */
  function teleportBot(id: number, x: number, y: number): void {
    const bot = bots.find(b => b.id === id);
    if (!bot || bot.dead) return;
    bot.x = x;
    bot.y = y;
    bot.vx = 0;
    bot.vy = 0;
    bot.invincibleUntil = Date.now() + BONUS_TELEPORT_INVINCIBLE_MS;
    const p = players.get(id);
    if (p) { p.x = x; p.y = y; }
  }

  console.log(`[AI] ${count} bots running (difficulty level ${difficultyLevel}/100)`);
  return { tick, damageBot, knockBot, applyBonus, teleportBot, isBotId: (id) => botIds.has(id) };
}
