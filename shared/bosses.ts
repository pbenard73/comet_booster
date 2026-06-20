// Boss enemies — rare, oversized "boss" bots. Single source of truth, imported by
// both runtimes (like shared/classes.ts).
//
// A boss is a pure DATA profile: stats + a visual/identity. **Only one boss exists
// at a time** (server/boss.ts). To add a new boss type, append a profile here — the
// server picks one at spawn and the client renders it from `PlayerState.boss`.
//
// Bosses differ from normal bots: ~3× the size, an enormous HP pool, passive
// regen, a multi-bolt volley (one bolt per in-range aggressor — parallel when it
// has only one target), and a purple radar blip. They are peaceful
// ("live their life") until attacked, then hunt their top damage-dealer. Normal
// bots never target a boss (server/bots.ts skips boss ids when aiming).

export interface BossProfile {
  id:              string;  // stable key stored in PlayerState.boss (e.g. 'tentacle')
  name:            string;  // callsign shown above the ship + on the leaderboard
  hp:              number;  // enormous health pool (server-authoritative damage)
  regenPerSec:     number;  // passive self-heal, HP per second
  bolts:           number;  // projectiles fired per volley — one per in-range aggressor (parallel fall-back)
  sizeMult:        number;  // logical size vs a full-grown normal ship (sprite + collisions)
  speed:           number;  // px/s max movement speed (bosses are slow & lumbering)
  shootRange:      number;  // world px — engages its aggressor within this range
  shootCooldownMs: number;  // ms between volleys
  dotColor:        number;  // radar blip colour (0xRRGGBB) — purple by request
}

/** The first boss: Tentacle — 100k HP, 5 HP/s regen, a 3-bolt multi-target volley. */
export const TENTACLE: BossProfile = {
  id:              'tentacle',
  name:            'Tentacle',
  hp:              100_000,
  regenPerSec:     5,
  bolts:           3,
  sizeMult:        3,
  speed:           130,
  shootRange:      1100,
  shootCooldownMs: 900,
  dotColor:        0x9b30ff,
};

export const BOSS_PROFILES: readonly BossProfile[] = [TENTACLE];

/** Look up a boss profile by id (used by the client to render `PlayerState.boss`). */
export function bossProfile(id: string | undefined): BossProfile | undefined {
  return id ? BOSS_PROFILES.find(b => b.id === id) : undefined;
}
