import {
  BASE_SHIP_SCALE, SCALE_PER_LEVEL, SHIP_SPRITE_FIT,
  BASE_HP, HP_PER_LEVEL,
} from '@shared/constants';
import { shipClass, type ShipClassId } from '@shared/classes';

/** Logical scale (1.0 = reference size) — drives collisions and engine/laser offsets. */
export const shipScaleForLevel = (level: number): number =>
  Math.min(BASE_SHIP_SCALE + (level - 1) * SCALE_PER_LEVEL, 1.0);

/** Visual texture scale — the logical scale fitted to the reference ship size. */
export const shipSpriteScale = (level: number): number =>
  shipScaleForLevel(level) * SHIP_SPRITE_FIT;

/** Max HP for a level & class — mirrors the server's bot HP formula so HP bars are
 *  accurate. The class's maxHpMult scales the base+level total. */
export const maxHpForLevel = (level: number, cls?: ShipClassId): number =>
  Math.round((BASE_HP + (level - 1) * HP_PER_LEVEL) * shipClass(cls).maxHpMult);
