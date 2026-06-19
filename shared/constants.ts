export const WORLD_WIDTH           = 10_000;
export const WORLD_HEIGHT          = 10_000;
export const PLAYER_SPEED          = 500;
export const PLAYER_ROTATION_SPEED = 200;
export const PLAYER_THRUST_SPEED   = 200;  // px/s — normal forward thrust speed

// Boost gauge — hold CONTROL while thrusting to accelerate to BOOST_SPEED_MULT×
// the thrust speed (to chase or escape). Draining a full gauge takes
// BOOST_DURATION_MS of use; the gauge refills from empty to full over BOOST_REGEN_MS.
export const BOOST_SPEED_MULT  = 3;      // 300% of thrust speed while boosting
export const BOOST_DURATION_MS = 5000;   // ms of boost available from a full gauge
export const BOOST_REGEN_MS    = 30000;  // ms to refill the gauge from 0 → 100%
export const BOOST_MIN_CHARGE  = 0.2;    // gauge must refill to 20% before boost can be re-engaged
export const SEND_RATE_MS          = 50;
export const PORT                  = 4000;
export const COLLISION_RADIUS      = 35;
export const SHIP_COUNT            = 72;  // number of random ship sprites in client/public/assets/ships

// Minimap (screen pixels)
export const MAP_SIZE = 150;
export const MAP_PAD  = 10;

// Level & HP system
export const BASE_HP            = 100;
export const HP_PER_LEVEL       = 10;

// Ship sizing. The level scale below is "logical" — 1.0 means the reference
// on-screen size and is reused for collision radius, engine/laser offsets, etc.
// The ship art has a different native pixel size, so the scale actually applied
// to the texture is the logical scale × SHIP_SPRITE_FIT (see shipSpriteScale).
export const SHIP_REF_PX        = 150;   // reference on-screen ship size (px) at max level
export const SHIP_NATIVE_PX     = 60;    // native pixel size of the current ship sprites
export const SHIP_SPRITE_FIT    = SHIP_REF_PX / SHIP_NATIVE_PX;  // texture scale → reference size

export const BASE_SHIP_SCALE    = 0.2;   // logical: 1/5 of full size at level 1
export const SCALE_PER_LEVEL    = 0.08;  // logical: full size (1.0) reached at level 11
export const DAMAGE_PER_HIT     = 34;    // ~3 hits to kill at level 1
export const DAMAGE_COOLDOWN_MS = 600;   // ms between damage ticks

// Ship-to-ship collision knockback: bounce apart while spinning, stunned (no
// control) like a pinball before recovering.
export const KNOCKBACK_STUN_MS    = 1200; // ms of lost control after a collision
export const KNOCKBACK_SPEED_MULT = 2;    // launch speed = mult × PLAYER_SPEED
export const KNOCKBACK_SPIN_DEG   = 720;  // spin angular velocity during the stun (deg/s)

// Laser system
export const LASER_SPEED        = 600;   // px/s
export const LASER_COOLDOWN_MS  = 350;   // ms between volleys
export const LASER_BASE_RANGE   = 400;   // px at level 1
export const LASER_RANGE_STEP   = 100;   // px added every 5 levels
export const LASER_CONE_LEVEL   = 25;    // level where cone mode activates
export const LASER_CONE_STEP_DEG = 3;    // degrees between adjacent cone lasers
export const LASER_WING_SPACING  = 15;   // px between parallel lasers
export const LASER_DAMAGE        = 10;   // HP damage per laser hit
export const LASER_HIT_FRACTION  = 0.75; // bolt hits within 75% of the sprite half-size from centre

// Fire-power gauge (ammo). Each shot costs one charge; you can't fire empty.
export const LASER_BASE_CHARGES   = 5;     // charges at level 1 (full gauge)
export const LASER_CHARGE_REGEN_MS = 2000; // ms to regenerate one charge
export const LASER_CHARGES_PER_5LV = 1;    // extra max charge gained every 5 levels

// XP / level gauge
export const XP_PER_HIT   = 1;    // XP awarded for landing a laser
export const XP_PER_KILL  = 5;    // XP awarded for destroying a ship
export const XP_TO_LEVEL  = 10;   // XP needed to level up

// Network / performance
export const AOI_RADIUS             = 2000;  // world px — entity updates only within this radius
export const MINIMAP_BOT_REFRESH_MS = 500;   // ms — bot dot positions on minimap (2 Hz)
export const SERVER_TICK_MS         = 50;    // ms — unified authoritative broadcast tick (20 Hz)
export const GRID_CELL              = AOI_RADIUS; // spatial-hash cell size (≥ AOI so a 3×3 block covers it)
export const MAX_NEIGHBORS          = 80;    // interest cap: max ships streamed to one client per tick

// Leaderboard
export const LEADERBOARD_SIZE       = 10;    // entries shown in the top-right ranking
export const LEADERBOARD_REFRESH_MS = 1000;  // ms — server recomputes & broadcasts ranking (1 Hz)
export const MAX_NAME_LEN           = 14;    // max characters in a player pseudo

// Bonuses (power-ups dropped by exploding ships)
export const BONUS_DROP_CHANCE       = 0.5;    // probability an exploding ship drops a bonus
export const BONUS_SIZE_PX           = 75;     // on-screen sprite size (px)
export const BONUS_PICKUP_PAD        = 18;     // extra px added to the ship radius for pickup overlap
export const BONUS_TTL_MS            = 20000;  // ms a dropped bonus lingers before despawning
export const MAX_BONUSES             = 30;     // global cap on concurrent world bonuses
export const BONUS_INVINCIBLE_MS     = 8000;   // 'invincible' bonus duration
export const BONUS_MEGA_MS           = 8000;   // 'mega_weapon' rapid-fire duration
export const BONUS_MEGA_COOLDOWN_MS  = 120;    // ms between shots while mega-weapon is active
export const BONUS_SHIELD_HITS       = 6;      // hits absorbed by the 'shield' bonus
export const BONUS_TELEPORT_INVINCIBLE_MS = 3000; // post-teleport invulnerability
export const TELEPORT_GRID           = 8;      // world is split TELEPORT_GRID² cells to find the emptiest
export const BONUS_SHIELD_VISUAL_MS  = 9000;   // ms a remote shield ring is shown (visual hint only)

// Bot bonus behaviour
export const BOT_BONUS_SEEK_RANGE    = 1200;   // px — bots steer toward a bonus within this range
export const BOT_POWERED_SPEED_MULT  = 1.4;    // movement boost while a bonus effect is active

// Bot shooting
export const BOT_DIFFICULTY        = 0.3;   // 0 = never shoot  1 = full strength  >1 = harder
export const BOT_SHOOT_RANGE       = 600;   // world px — max range at difficulty 1
export const BOT_SHOOT_COOLDOWN_MS = 1500;  // ms between shots at difficulty 1
export const BOT_SHOOT_DAMAGE      = 10;    // HP per bot laser hit
