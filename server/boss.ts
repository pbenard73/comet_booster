import type { TemplatedApp } from 'uWebSockets.js';
import {
  WORLD_WIDTH, WORLD_HEIGHT, SERVER_TICK_MS, SHIP_COUNT, LASER_SPEED,
  BOSS_RESPAWN_MS, BOSS_DPS_WINDOW_MS, gameSpeedMult,
} from '../shared/constants.js';
import type { ServerMessage } from '../shared/types.js';
import type { ServerPlayer } from './score.js';
import { BOSS_PROFILES, type BossProfile } from '../shared/bosses.js';
import { GAME_SPEED_CONFIG } from './config.js';

// The boss shares the global game-speed knob (movement + bolt speed) with ships
// and bots, so the whole arena scales together.
const GAME_SPEED = gameSpeedMult(GAME_SPEED_CONFIG);
const BOSS_TURN_STEP = 2 * GAME_SPEED;   // deg/tick — bosses turn slowly (big & lumbering)
// Perpendicular gap between bolts that share a target (the parallel fall-back when
// fewer aggressors are in range than the boss has bolts). Wide — the boss is huge.
const BOSS_BOLT_SPACING = 60;

/** A laser bolt fired by the boss this tick (merged into the unified tick's laser pass). */
export type BossShot = { shooterId: number; targetId: number; x: number; y: number; vx: number; vy: number };

/** One recent damage event against the boss — the sliding window picks the top dealer. */
type DamageEvent = { shooterId: number; amount: number; t: number };

interface Boss {
  id:       number;
  profile:  BossProfile;
  x:        number;
  y:        number;
  angle:    number;
  vx:       number;
  vy:       number;
  targetX:  number;   // wander waypoint (when nobody is attacking)
  targetY:  number;
  hp:       number;
  dead:     boolean;
  lastShot: number;
  damage:   DamageEvent[];  // recent hits, pruned to BOSS_DPS_WINDOW_MS each tick
}

export interface BossController {
  /** Advance the boss one step; returns the laser shots fired this tick (or []). */
  tick(now: number): BossShot[];
  /** Apply laser damage to the boss and record the aggressor (for top-DPS targeting). */
  damage(id: number, amount: number, shooterId: number): void;
  /** True for the live boss id — bots use it to never aim at / shoot the boss. */
  isBoss(id: number): boolean;
}

function wrap(v: number, max: number) { return ((v % max) + max) % max; }
/** Torus-shortest signed delta FROM `from` TO `to` on a wrapped axis of length `size`. */
function toward(from: number, to: number, size: number): number {
  let d = to - from;
  if (d >  size / 2) d -= size;
  else if (d < -size / 2) d += size;
  return d;
}

export function startBoss(
  app: TemplatedApp,
  players: Map<number, ServerPlayer>,
  allocateId: () => number,
  onKilled: (shooterId: number) => void,
): BossController {
  let boss: Boss | null = null;

  /** Spawn a fresh boss (picks a random profile — currently only Tentacle). */
  function spawnBoss(): void {
    const profile = BOSS_PROFILES[Math.floor(Math.random() * BOSS_PROFILES.length)];
    const id = allocateId();
    const x  = Math.random() * WORLD_WIDTH;
    const y  = Math.random() * WORLD_HEIGHT;
    boss = {
      id, profile, x, y,
      angle:    Math.random() * 360 - 180,
      vx: 0, vy: 0,
      targetX:  Math.random() * WORLD_WIDTH,
      targetY:  Math.random() * WORLD_HEIGHT,
      hp:       profile.hp,
      dead:     false,
      lastShot: 0,
      damage:   [],
    };
    // The boss is a fake player (like a bot) but flagged with `boss` so clients
    // render it 3× size with a purple radar blip and a huge HP bar.
    players.set(id, {
      id, x, y, angle: boss.angle, dead: false, level: 1, xp: 0,
      name: profile.name, ship: Math.floor(Math.random() * SHIP_COUNT),
      cls: 'normal', teamId: 0, bot: true, boss: profile.id,
    });
    app.publish('all', JSON.stringify({ type: 'player_join', player: players.get(id)! } as ServerMessage));
    console.log(`[BOSS] ${profile.name} spawned (id ${id}, ${profile.hp} HP)`);
  }

  /** Turn toward (dx, dy) and integrate one step (mirrors the bot steering feel). */
  function steer(b: Boss, dx: number, dy: number): void {
    const dt = SERVER_TICK_MS / 1000;
    const desired = (Math.atan2(dy, dx) + Math.PI / 2) * 180 / Math.PI;
    const diff    = ((desired - b.angle + 540) % 360) - 180;
    b.angle += Math.max(-BOSS_TURN_STEP, Math.min(BOSS_TURN_STEP, diff));
    b.angle  = ((b.angle + 540) % 360) - 180;

    const rot   = (b.angle - 90) * Math.PI / 180;
    const speed = b.profile.speed * GAME_SPEED;
    b.vx = b.vx * 0.94 + Math.cos(rot) * speed * 0.06;
    b.vy = b.vy * 0.94 + Math.sin(rot) * speed * 0.06;
    b.x  = wrap(b.x + b.vx * dt, WORLD_WIDTH);
    b.y  = wrap(b.y + b.vy * dt, WORLD_HEIGHT);
  }

  function tick(now: number): BossShot[] {
    if (!boss || boss.dead) return [];
    const b  = boss;
    const dt = SERVER_TICK_MS / 1000;

    // Passive regeneration up to the full pool.
    if (b.hp < b.profile.hp) b.hp = Math.min(b.profile.hp, b.hp + b.profile.regenPerSec * dt);

    // Priority target = whoever dealt the most damage over the last window. Prune
    // stale damage first, then sum per attacker.
    const cutoff = now - BOSS_DPS_WINDOW_MS;
    b.damage = b.damage.filter(d => d.t >= cutoff);
    let topId = 0, topDmg = 0;
    const totals = new Map<number, number>();
    for (const d of b.damage) {
      const sum = (totals.get(d.shooterId) ?? 0) + d.amount;
      totals.set(d.shooterId, sum);
      if (sum > topDmg) { topDmg = sum; topId = d.shooterId; }
    }
    const target  = topId ? players.get(topId) : undefined;
    const engaged = !!(target && !target.dead);

    // Steer: hunt the top aggressor; otherwise wander tranquilly to a waypoint.
    let dx: number, dy: number;
    if (engaged) {
      dx = toward(b.x, target!.x, WORLD_WIDTH);
      dy = toward(b.y, target!.y, WORLD_HEIGHT);
    } else {
      dx = b.targetX - b.x;
      dy = b.targetY - b.y;
      if (dx * dx + dy * dy < 400 * 400) {
        b.targetX = Math.random() * WORLD_WIDTH;
        b.targetY = Math.random() * WORLD_HEIGHT;
        dx = b.targetX - b.x;
        dy = b.targetY - b.y;
      }
    }
    steer(b, dx, dy);

    const p = players.get(b.id);
    if (p) { p.x = b.x; p.y = b.y; p.angle = b.angle; }

    // Multi-target volley: fire `bolts` projectiles at the boss's recent aggressors
    // — one bolt aimed at each, in its OWN direction, so it can engage several
    // attackers at once. Targets = the top damage-dealers that are alive and in
    // range, most-damage first. When fewer attackers are in range than there are
    // bolts, the surplus bolts double up on a target as a PARALLEL pair/triple
    // (same heading, perpendicular spawn offset) — so a lone attacker eats 3
    // parallel bolts rather than a cone.
    const shots: BossShot[] = [];
    if (now >= b.lastShot + b.profile.shootCooldownMs) {
      const range = b.profile.shootRange * GAME_SPEED;
      const targets = [...totals.entries()]
        .sort((a, c) => c[1] - a[1])
        .map(([id]) => players.get(id))
        .filter((t): t is ServerPlayer => !!t && !t.dead
          && Math.hypot(toward(b.x, t.x, WORLD_WIDTH), toward(b.y, t.y, WORLD_HEIGHT)) <= range)
        .slice(0, b.profile.bolts);

      if (targets.length > 0) {
        b.lastShot = now;
        const n = b.profile.bolts;
        for (let i = 0; i < n; i++) {
          const t    = targets[i % targets.length];
          const ang  = Math.atan2(toward(b.y, t.y, WORLD_HEIGHT), toward(b.x, t.x, WORLD_WIDTH));
          const dirX = Math.cos(ang), dirY = Math.sin(ang);
          // How many bolts share this target, and this bolt's index within them,
          // so duplicates fan out parallel & centred rather than overlapping.
          const groupSize = Math.ceil((n - (i % targets.length)) / targets.length);
          const groupIdx  = Math.floor(i / targets.length);
          const off       = (groupIdx - (groupSize - 1) / 2) * BOSS_BOLT_SPACING;
          shots.push({
            shooterId: b.id, targetId: t.id,
            x:  Math.round(b.x - dirY * off),   // offset ⟂ to the heading
            y:  Math.round(b.y + dirX * off),
            vx: Math.round(dirX * LASER_SPEED * GAME_SPEED),
            vy: Math.round(dirY * LASER_SPEED * GAME_SPEED),
          });
        }
      }
    }
    return shots;
  }

  function damage(id: number, amount: number, shooterId: number): void {
    if (!boss || boss.dead || boss.id !== id) return;
    boss.damage.push({ shooterId, amount, t: Date.now() });
    boss.hp -= amount;
    if (boss.hp > 0) return;

    // Defeated. Announce the death, reward the finisher, then after a delay drop
    // this boss entirely (player_leave) and spawn a brand-new one — keeping the
    // "only one at a time" rule and a clean fresh-sprite respawn on every client.
    boss.dead = true;
    const p = players.get(boss.id);
    if (p) p.dead = true;
    const deadId = boss.id;
    app.publish('all', JSON.stringify({ type: 'player_die', id: deadId } as ServerMessage));
    onKilled(shooterId);
    console.log(`[BOSS] ${boss.profile.name} (id ${deadId}) destroyed by ${shooterId}`);
    setTimeout(() => {
      players.delete(deadId);
      app.publish('all', JSON.stringify({ type: 'player_leave', id: deadId } as ServerMessage));
      spawnBoss();
    }, BOSS_RESPAWN_MS);
  }

  spawnBoss();
  return {
    tick,
    damage,
    isBoss: (id) => boss !== null && boss.id === id && !boss.dead,
  };
}
