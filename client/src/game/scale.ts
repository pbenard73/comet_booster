import {
  BASE_SHIP_SCALE, SCALE_PER_LEVEL, SHIP_SPRITE_FIT,
  BASE_HP, HP_PER_LEVEL,
} from '@shared/constants';

/** Logical scale (1.0 = reference size) — drives collisions and engine/laser offsets. */
export const shipScaleForLevel = (level: number): number =>
  Math.min(BASE_SHIP_SCALE + (level - 1) * SCALE_PER_LEVEL, 1.0);

/** Visual texture scale — the logical scale fitted to the reference ship size. */
export const shipSpriteScale = (level: number): number =>
  shipScaleForLevel(level) * SHIP_SPRITE_FIT;

/** Max HP for a level — mirrors the server's bot HP formula so HP bars are accurate. */
export const maxHpForLevel = (level: number): number =>
  BASE_HP + (level - 1) * HP_PER_LEVEL;
