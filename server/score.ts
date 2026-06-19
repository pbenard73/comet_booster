import { XP_TO_LEVEL, MAX_NAME_LEN } from '../shared/constants.js';
import type { PlayerState } from '../shared/types.js';

export type ServerPlayer = PlayerState & { dead: boolean; xp: number; name: string };

/** Total "points" used for ranking — accumulated level progression. */
export function scoreOf(p: ServerPlayer): number {
  return (p.level - 1) * XP_TO_LEVEL + p.xp;
}

/** Strip control chars, collapse whitespace, clamp length. Names are only ever
 *  drawn in Phaser canvas text (no DOM), so HTML injection is not a concern. */
export function sanitizeName(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw.replace(/[\x00-\x1f\x7f]/g, '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_LEN);
}
