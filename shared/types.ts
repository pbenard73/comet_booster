import type { ShipClassId } from './classes.js';

export interface PlayerState {
  id:     number;
  x:      number;
  y:      number;
  angle:  number;
  dead?:  boolean;
  level:  number;
  ship:   number;   // index into the ship sprite pool (assigned by server, stable per player)
  name:   string;   // pseudo shown above the ship
  cls?:   ShipClassId;  // chosen RPG class (default 'normal'); drives stats + label marker
  teamId?: number;  // 0/undefined = no team; shared by all members of a connected team (see server mergeTeams)
  bot?:   boolean;  // true for AI bots (dev only) — humans omit it. Lets clients suppress human-laser visuals.
  boss?:  string;   // boss profile id (shared/bosses.ts) when this is a boss bot; drives 3× size + purple radar blip + huge HP
}

// Power-up bonuses dropped by exploding ships. The kinds map 1:1 to the icons in
// client/public/assets/bonus/<kind>.png (loaded as texture key `bonus_<kind>`).
export type BonusType = 'fix' | 'invincible' | 'mega_weapon' | 'shield' | 'teleport';
export const BONUS_KINDS: readonly BonusType[] = ['fix', 'invincible', 'mega_weapon', 'shield', 'teleport'];

/** A bonus pickup floating in the world (server-authoritative, shared by all clients). */
export interface BonusState {
  id:   number;      // unique bonus id (separate counter from player ids)
  kind: BonusType;
  x:    number;
  y:    number;
}

// Messages sent by the server → client
export type ServerMessage =
  | { type: 'init';            id: number; players: PlayerState[]; bonuses: BonusState[]; gameSpeed: number }
  | { type: 'player_join';     player: PlayerState }
  | { type: 'player_move';     id: number; x: number; y: number; angle: number }
  | { type: 'player_die';      id: number }
  | { type: 'player_respawn';  id: number; x: number; y: number; level: number }
  | { type: 'player_leave';    id: number }
  | { type: 'player_rename';   id: number; name: string }
  | { type: 'player_class';    id: number; cls: ShipClassId }   // a player picked/changed their class
  | { type: 'player_level_up'; id: number; level: number }
  | { type: 'player_hit';      id: number; damage: number; shooterId: number }
  | { type: 'xp_update';       xp: number; xpMax: number }
  | { type: 'bulk_move';       updates:   Array<{ id: number; x: number; y: number; angle: number }> }
  | { type: 'minimap_update';  positions: Array<{ id: number; x: number; y: number }> }
  | { type: 'laser_spawn';     shooterId: number; x: number; y: number; vx: number; vy: number }
  | { type: 'bonus_spawn';     bonus: BonusState }
  | { type: 'bonus_remove';    id: number; pickerId: number }   // pickerId 0 = expired/no picker
  | { type: 'bonus_teleport';  id: number; x: number; y: number }
  | { type: 'player_effect';   id: number; kind: BonusType; ms: number }   // show a power-up effect on a ship
  | { type: 'leaderboard';     top: LeaderboardEntry[]; rank: number; score: number; total: number }
  | { type: 'team_invite';     fromId: number; fromName: string }   // someone wants to team up → show confirm popup
  | { type: 'team_set';        updates: Array<{ id: number; teamId: number }> };  // team membership changed (bulk)

export interface LeaderboardEntry {
  name:  string;
  score: number;
  me:    boolean;
}

// Messages sent by the client → server
export type ClientMessage =
  | { type: 'move';     x: number; y: number; angle: number }
  | { type: 'die';      killedBy?: number }
  | { type: 'respawn' }
  | { type: 'hit';      targetId: number }
  | { type: 'fire';     bolts: Array<{ x: number; y: number; vx: number; vy: number }> }  // broadcast my laser bolts so others see them
  | { type: 'collide';  targetId: number }
  | { type: 'bonus_pickup'; id: number }   // request to claim a world bonus
  | { type: 'use_teleport' }               // teleport bonus activated (server picks the destination)
  | { type: 'notify_effect'; kind: BonusType; ms: number }  // I activated a bonus → broadcast it so others see it
  | { type: 'team_invite_send';    toId: number }           // invite a player to team up (sent on spawn from the menu choice)
  | { type: 'team_invite_respond'; fromId: number; accept: boolean }  // answer an invite
  | { type: 'set_class'; cls: ShipClassId }                 // pick a ship class (sent on spawn from the menu)
  | { type: 'set_name'; name: string };
