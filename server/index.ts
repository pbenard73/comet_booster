import uWS, { type WebSocket } from 'uWebSockets.js';
import {
  PORT, WORLD_WIDTH, WORLD_HEIGHT, SHIP_COUNT,
  LASER_DAMAGE, XP_PER_HIT, XP_PER_KILL, XP_TO_LEVEL,
  AOI_RADIUS, BOT_SHOOT_DAMAGE, MINIMAP_BOT_REFRESH_MS,
  SERVER_TICK_MS, MAX_NEIGHBORS,
  LEADERBOARD_SIZE, LEADERBOARD_REFRESH_MS,
  BONUS_DROP_CHANCE, BONUS_TTL_MS, MAX_BONUSES, TELEPORT_GRID,
  BONUS_SIZE_PX, BONUS_PICKUP_PAD, COLLISION_RADIUS, BASE_SHIP_SCALE, SCALE_PER_LEVEL,
  BONUS_INVINCIBLE_MS, BONUS_MEGA_MS, BONUS_SHIELD_VISUAL_MS,
} from '../shared/constants.js';
import { BONUS_KINDS } from '../shared/types.js';
import type { ServerMessage, ClientMessage, LeaderboardEntry, BonusState, BonusType } from '../shared/types.js';
import { startBots, type BotController } from './bots.js';
import { SpatialGrid } from './grid.js';
import { serveStatic } from './static.js';
import { scoreOf, sanitizeName, type ServerPlayer } from './score.js';

// ── Game state ─────────────────────────────────────────────────────────────

interface WsData { id: number }

const players  = new Map<number, ServerPlayer>();
const sockets  = new Map<number, WebSocket<WsData>>();
const bonuses  = new Map<number, BonusState>();
const grid     = new SpatialGrid();
let botCtrl: BotController | null = null;
let nextId = 1;
let nextBonusId = 1;
const allocateId = () => nextId++;
const aoiSq = AOI_RADIUS * AOI_RADIUS;

const randomShip = () => Math.floor(Math.random() * SHIP_COUNT);

function randomSpawn(): { x: number; y: number } {
  return {
    x: Math.floor(Math.random() * WORLD_WIDTH),
    y: Math.floor(Math.random() * WORLD_HEIGHT),
  };
}

function sendDirect(playerId: number, msg: ServerMessage): void {
  sockets.get(playerId)?.send(JSON.stringify(msg));
}

function awardXP(playerId: number, amount: number): void {
  const p = players.get(playerId);
  if (!p || p.dead) return;
  p.xp += amount;
  if (p.xp >= XP_TO_LEVEL) {
    p.xp -= XP_TO_LEVEL;
    p.level++;
    app.publish('all', JSON.stringify({ type: 'player_level_up', id: playerId, level: p.level } as ServerMessage));
  }
  sendDirect(playerId, { type: 'xp_update', xp: p.xp, xpMax: XP_TO_LEVEL });
}

function broadcastLeaderboard(): void {
  if (sockets.size === 0) return;

  const ranked = [...players.values()]
    .map(p => ({ id: p.id, name: p.name, score: scoreOf(p) }))
    .sort((a, b) => b.score - a.score || a.id - b.id);

  const rankById = new Map<number, number>();
  ranked.forEach((e, i) => rankById.set(e.id, i + 1));

  const top   = ranked.slice(0, LEADERBOARD_SIZE);
  const total = ranked.length;

  for (const [socketId, ws] of sockets) {
    const me = players.get(socketId);
    if (!me) continue;
    const personalTop: LeaderboardEntry[] =
      top.map(e => ({ name: e.name, score: e.score, me: e.id === socketId }));
    ws.send(JSON.stringify({
      type:  'leaderboard',
      top:   personalTop,
      rank:  rankById.get(socketId) ?? total,
      score: scoreOf(me),
      total,
    } as ServerMessage));
  }
}

// ── Bonuses (power-up drops) ─────────────────────────────────────────────────

/** Spawn a bonus at (x, y) and broadcast it (capped at MAX_BONUSES). It auto-
 *  expires after BONUS_TTL_MS if nobody picks it up. */
function spawnBonus(x: number, y: number): void {
  if (bonuses.size >= MAX_BONUSES) return;
  const id   = nextBonusId++;
  const kind = BONUS_KINDS[Math.floor(Math.random() * BONUS_KINDS.length)];
  const bonus: BonusState = { id, kind, x: Math.round(x), y: Math.round(y) };
  bonuses.set(id, bonus);
  app.publish('all', JSON.stringify({ type: 'bonus_spawn', bonus } as ServerMessage));
  setTimeout(() => removeBonus(id, 0), BONUS_TTL_MS);
}

/** Remove a bonus (claimed by `pickerId`, or expired when pickerId === 0). */
function removeBonus(id: number, pickerId: number): void {
  if (!bonuses.delete(id)) return;
  app.publish('all', JSON.stringify({ type: 'bonus_remove', id, pickerId } as ServerMessage));
}

/** A ship just exploded at (x, y): one-in-two chance to drop a bonus. */
function maybeDropBonus(x: number, y: number): void {
  if (Math.random() < BONUS_DROP_CHANCE) spawnBonus(x, y);
}

/** Pickup overlap radius for a ship of `level` — mirrors the client's check. */
function bonusPickupRadius(level: number): number {
  const scale = Math.min(BASE_SHIP_SCALE + (level - 1) * SCALE_PER_LEVEL, 1.0);
  return COLLISION_RADIUS * scale + BONUS_SIZE_PX / 2 + BONUS_PICKUP_PAD;
}

/** Broadcast a ship's power-up effect so every client can render it (blink /
 *  tint / shield ring). Only the lingering effects carry a visual. */
function broadcastEffect(id: number, kind: BonusType): void {
  const ms = kind === 'invincible'  ? BONUS_INVINCIBLE_MS
           : kind === 'mega_weapon' ? BONUS_MEGA_MS
           : kind === 'shield'      ? BONUS_SHIELD_VISUAL_MS
           : 0;
  if (ms === 0) return;   // fix / teleport: no lingering visual
  app.publish('all', JSON.stringify({ type: 'player_effect', id, kind, ms } as ServerMessage));
}

/** Let bots claim any bonus they're touching (humans claim client-side). A bot
 *  uses the bonus immediately; teleport picks the least-crowded cell. */
function botPickups(): void {
  if (!botCtrl || bonuses.size === 0) return;
  for (const bonus of [...bonuses.values()]) {
    let claimer = 0;
    grid.forEachNear(bonus.x, bonus.y, 1, (o) => {
      if (claimer || o.dead || !botCtrl!.isBotId(o.id)) return;
      const dx = o.x - bonus.x, dy = o.y - bonus.y, r = bonusPickupRadius(o.level);
      if (dx * dx + dy * dy <= r * r) claimer = o.id;
    });
    if (!claimer) continue;
    removeBonus(bonus.id, claimer);
    if (bonus.kind === 'teleport') {
      const dst = lowestDensityPos();
      botCtrl.teleportBot(claimer, dst.x, dst.y);
    } else {
      botCtrl.applyBonus(claimer, bonus.kind);
    }
    broadcastEffect(claimer, bonus.kind);   // make the bot's use visible to everyone
  }
}

/** Find the centre of the least-crowded TELEPORT_GRID² cell (for the teleport bonus). */
function lowestDensityPos(): { x: number; y: number } {
  const counts = new Array(TELEPORT_GRID * TELEPORT_GRID).fill(0);
  const cw = WORLD_WIDTH / TELEPORT_GRID, ch = WORLD_HEIGHT / TELEPORT_GRID;
  for (const p of players.values()) {
    if (p.dead) continue;
    const cx = Math.min(TELEPORT_GRID - 1, Math.floor(p.x / cw));
    const cy = Math.min(TELEPORT_GRID - 1, Math.floor(p.y / ch));
    counts[cy * TELEPORT_GRID + cx]++;
  }
  let best = 0;
  for (let i = 1; i < counts.length; i++) if (counts[i] < counts[best]) best = i;
  const gx = best % TELEPORT_GRID, gy = Math.floor(best / TELEPORT_GRID);
  return {
    x: Math.round((gx + 0.5) * cw + (Math.random() - 0.5) * cw * 0.5),
    y: Math.round((gy + 0.5) * ch + (Math.random() - 0.5) * ch * 0.5),
  };
}

// ── Server ─────────────────────────────────────────────────────────────────

const app = uWS.App();

// Static files (production only — dev uses Vite)
app.get('/*', serveStatic);

// WebSocket
app.ws<WsData>('/ws', {
  compression:      uWS.SHARED_COMPRESSOR,
  maxPayloadLength: 16 * 1024,
  idleTimeout:      60,

  open(ws: WebSocket<WsData>) {
    const id = nextId++;
    ws.getUserData().id = id;
    ws.subscribe('all');
    sockets.set(id, ws);

    const spawn = randomSpawn();
    players.set(id, { id, ...spawn, angle: 0, dead: false, level: 1, xp: 0, name: `Pilot${id}`, ship: randomShip() });

    const init: ServerMessage = { type: 'init', id, players: [...players.values()], bonuses: [...bonuses.values()] };
    ws.send(JSON.stringify(init));
    sendDirect(id, { type: 'xp_update', xp: 0, xpMax: XP_TO_LEVEL });

    const join: ServerMessage = { type: 'player_join', player: players.get(id)! };
    app.publish('all', JSON.stringify(join));

    console.log(`[+] Player ${id} connected  (${players.size} online)`);
  },

  message(ws: WebSocket<WsData>, raw: ArrayBuffer) {
    let msg: ClientMessage;
    try { msg = JSON.parse(Buffer.from(raw).toString()) as ClientMessage; }
    catch { return; }

    const { id } = ws.getUserData();

    switch (msg.type) {
      case 'move': {
        // Just record the new position — the unified 20 Hz tick batches all
        // movement into per-socket AoI broadcasts (no per-message O(N) scan).
        const p = players.get(id);
        if (!p || p.dead) break;
        p.x     = msg.x;
        p.y     = msg.y;
        p.angle = msg.angle;
        break;
      }

      case 'set_name': {
        const p = players.get(id);
        if (!p) break;
        const name = sanitizeName(msg.name);
        if (name) {
          p.name = name;
          app.publish('all', JSON.stringify({ type: 'player_rename', id, name } as ServerMessage));
        }
        break;
      }

      case 'hit': {
        const shooter = players.get(id);
        const target  = players.get(msg.targetId);
        if (!shooter || shooter.dead || !target || target.dead) break;
        const hit: ServerMessage = { type: 'player_hit', id: msg.targetId, damage: LASER_DAMAGE, shooterId: id };
        app.publish('all', JSON.stringify(hit));
        awardXP(id, XP_PER_HIT);
        botCtrl?.damageBot(msg.targetId, LASER_DAMAGE, id);
        break;
      }

      case 'collide': {
        // The local player already bounced itself; mirror the bounce onto the
        // other ship. Human ships bounce on their own client, so only bots need
        // a server-side knockback.
        const shooter = players.get(id);
        if (!shooter || shooter.dead) break;
        if (botCtrl?.isBotId(msg.targetId)) {
          botCtrl.knockBot(msg.targetId, shooter.x, shooter.y);
        }
        break;
      }

      case 'die': {
        const p = players.get(id);
        if (!p || p.dead) break;
        p.dead = true;
        app.publish('all', JSON.stringify({ type: 'player_die', id } as ServerMessage));
        maybeDropBonus(p.x, p.y);
        if (msg.killedBy !== undefined && !botCtrl?.isBotId(msg.killedBy)) {
          awardXP(msg.killedBy, XP_PER_KILL);
        }
        break;
      }

      case 'bonus_pickup': {
        // First valid claim wins; the bonus is removed for everyone and the
        // picker is told (via pickerId) so it can grant the held power-up.
        const p = players.get(id);
        if (!p || p.dead) break;
        if (bonuses.has(msg.id)) removeBonus(msg.id, id);
        break;
      }

      case 'use_teleport': {
        const p = players.get(id);
        if (!p || p.dead) break;
        const dst = lowestDensityPos();
        p.x = dst.x;
        p.y = dst.y;
        app.publish('all', JSON.stringify({ type: 'bonus_teleport', id, x: dst.x, y: dst.y } as ServerMessage));
        break;
      }

      case 'notify_effect': {
        // A human activated a power-up → re-broadcast so other clients render it.
        const p = players.get(id);
        if (!p || p.dead) break;
        app.publish('all', JSON.stringify({ type: 'player_effect', id, kind: msg.kind, ms: msg.ms } as ServerMessage));
        break;
      }

      case 'respawn': {
        const p = players.get(id);
        if (!p || !p.dead) break;
        const spawn = randomSpawn();
        p.x     = spawn.x;
        p.y     = spawn.y;
        p.angle = 0;
        p.dead  = false;
        p.level = 1;
        p.xp    = 0;
        app.publish('all', JSON.stringify({ type: 'player_respawn', id, x: p.x, y: p.y, level: 1 } as ServerMessage));
        sendDirect(id, { type: 'xp_update', xp: 0, xpMax: XP_TO_LEVEL });
        break;
      }
    }
  },

  close(ws: WebSocket<WsData>) {
    const { id } = ws.getUserData();
    players.delete(id);
    sockets.delete(id);
    app.publish('all', JSON.stringify({ type: 'player_leave', id } as ServerMessage));
    console.log(`[-] Player ${id} disconnected  (${players.size} online)`);
  },
});

// ── Listen ─────────────────────────────────────────────────────────────────

app.listen(PORT, (token) => {
  if (token) {
    console.log(`Server  →  http://localhost:${PORT}`);
    console.log(`WebSocket  ws://localhost:${PORT}/ws`);
    if (process.env.NODE_ENV !== 'production') {
      // Killing a bot earns the shooter (bot or human) kill XP, so bot-vs-bot
      // fights move the leaderboard the same way human kills do.
      botCtrl = startBots(app, players, allocateId, 250, (shooterId) => awardXP(shooterId, XP_PER_KILL), maybeDropBonus);
    }

    // ── Unified authoritative tick (20 Hz, dev + prod) ──────────────────────
    // The single hot loop: advance bots, then deliver each socket one AoI
    // `bulk_move` built from a spatial grid (O(N + Σ neighbours), not O(N²)),
    // capped to the nearest MAX_NEIGHBORS so CPU + egress stay bounded at any
    // density. Replaces the old per-message human broadcast.
    setInterval(() => {
      const now = Date.now();
      let shots: ReturnType<BotController['tick']> = [];
      if (botCtrl) {
        grid.rebuild(players.values());        // bots aim against current positions
        shots = botCtrl.tick(now, grid, [...bonuses.values()]);
      }
      grid.rebuild(players.values());          // fresh positions for the broadcast
      botPickups();                            // bots grab any bonus they're touching

      for (const [socketId, ws] of sockets) {
        const me = players.get(socketId);
        if (!me) continue;
        const near: Array<{ id: number; x: number; y: number; angle: number; d2: number }> = [];
        grid.forEachNear(me.x, me.y, 1, (o) => {
          if (o.id === socketId) return;
          const dx = o.x - me.x, dy = o.y - me.y;
          const d2 = dx * dx + dy * dy;
          if (d2 <= aoiSq) {
            near.push({ id: o.id, x: Math.round(o.x), y: Math.round(o.y), angle: Math.round(o.angle), d2 });
          }
        });
        if (near.length === 0) continue;
        if (near.length > MAX_NEIGHBORS) {
          near.sort((a, b) => a.d2 - b.d2);
          near.length = MAX_NEIGHBORS;
        }
        const updates = near.map(({ id, x, y, angle }) => ({ id, x, y, angle }));
        ws.send(JSON.stringify({ type: 'bulk_move', updates } as ServerMessage));
      }

      // Bot shots → laser visual; bot targets take damage server-side (no client
      // to simulate the bolt), human targets resolve it on their own client.
      for (const { shooterId, targetId, x, y, vx, vy } of shots) {
        const target = players.get(targetId);
        if (!target || target.dead) continue;
        app.publish('all', JSON.stringify({ type: 'laser_spawn', shooterId, x, y, vx, vy } as ServerMessage));
        if (botCtrl?.isBotId(targetId)) {
          app.publish('all', JSON.stringify({ type: 'player_hit', id: targetId, damage: BOT_SHOOT_DAMAGE, shooterId } as ServerMessage));
          awardXP(shooterId, XP_PER_HIT);   // landing the bolt earns hit XP (mirrors human 'hit')
          botCtrl.damageBot(targetId, BOT_SHOOT_DAMAGE, shooterId);
        }
      }
    }, SERVER_TICK_MS);

    // Minimap: all live entities at 2 Hz (no AoI filter) — one publish, uWS fans
    // out. Keeps far ships (beyond the MAX_NEIGHBORS interest cap) moving on the
    // radar. Runs in prod too now so the globe works without bots.
    setInterval(() => {
      const positions = [...players.values()]
        .filter(p => !p.dead)
        .map(p => ({ id: p.id, x: Math.round(p.x), y: Math.round(p.y) }));
      if (positions.length > 0) {
        app.publish('all', JSON.stringify({ type: 'minimap_update', positions } as ServerMessage));
      }
    }, MINIMAP_BOT_REFRESH_MS);

    // Leaderboard: rank everyone by score, send a personalized top-N + own rank
    // to each human socket. Runs in prod too (humans rank against each other).
    setInterval(broadcastLeaderboard, LEADERBOARD_REFRESH_MS);
  } else {
    console.error(`Failed to bind port ${PORT}`);
    process.exit(1);
  }
});
