// Runtime-overridable server config. Bot count and difficulty fall back to the
// shared constants when their env vars are unset/blank/invalid — so dev keeps the
// in-code defaults while prod can be tuned without a rebuild (e.g.
// `BOT_COUNT=500 BOT_DIFFICULTY=80 npm start`).
import {
  BOT_COUNT, BOT_DIFFICULTY_LEVEL, BOT_DIFFICULTY_MIN, BOT_DIFFICULTY_MAX,
} from '../shared/constants.js';

/** Read an integer env var, clamped to [min, max]; fall back to `def` if unset/blank/non-numeric. */
function envInt(name: string, def: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return def;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    console.warn(`[config] ${name}="${raw}" is not a number — falling back to ${def}`);
    return def;
  }
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** Number of AI bots to spawn (env: BOT_COUNT). */
export const BOT_COUNT_CONFIG = envInt('BOT_COUNT', BOT_COUNT, 0, 100_000);

/** Bot difficulty level 1–100 (env: BOT_DIFFICULTY). */
export const BOT_DIFFICULTY_CONFIG = envInt(
  'BOT_DIFFICULTY', BOT_DIFFICULTY_LEVEL, BOT_DIFFICULTY_MIN, BOT_DIFFICULTY_MAX,
);
