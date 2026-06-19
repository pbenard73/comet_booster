// Client-only UI / rendering constants shared by the game modules.

/** Texture key for a ship sprite index (BootScene loads ship_0 … ship_71). */
export const shipKey = (ship: number): string => `ship_${ship}`;

export const ENGINE_OFFSET   = 44;     // logical px from ship centre to engine mount
export const INVINCIBLE_MS   = 3000;   // post-respawn invulnerability window
export const NAME_LABEL_DIST = 1400;   // world px — only render labels/bars for nearby ships (perf)
export const HP_BAR_W        = 30;     // mini health bar size (world-space, above each ship)
export const HP_BAR_H        = 4;
