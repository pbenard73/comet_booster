// Ship classes (RPG roles). Single source of truth, imported by both runtimes.
//
// A class is a pure DATA profile: a set of stat multipliers plus a visual identity
// (an emoji marker + label colour shown above the ship). "normal" is the no-bonus
// default. Every multiplier defaults to 1 ("no change"); `regenPerSec` /
// `teamHealPerSec` are absolute HP-per-second values (0 = none).
//
// To add a new class: append an entry to SHIP_CLASSES (and SHIP_CLASS_ORDER), no
// other file needs to change for the stat-based effects to take hold. See the
// `ship-class` skill for the full how-to and which levers exist.

export type ShipClassId =
  | 'normal' | 'sentinel' | 'berserker' | 'support' | 'scout'
  | 'sniper' | 'engineer' | 'trickster' | 'saboteur' | 'tempest';

export interface ShipClass {
  id:     ShipClassId;
  name:   string;   // display name (menu + tooltips)
  marker: string;   // emoji shown before the pseudo above the ship ('' for normal)
  color:  string;   // label colour when not on a team (hex string)
  blurb:  string;   // one-line gameplay summary (menu)

  // ── Stat levers (multipliers unless noted) ────────────────────────────────
  maxHpMult:         number; // max HP
  damageMult:        number; // outgoing laser damage (server-authoritative for humans)
  fireCooldownMult:  number; // <1 = fires faster (multiplies LASER_COOLDOWN_MS)
  chargeRegenMult:   number; // >1 = ammo gauge refills faster
  bonusCharges:      number; // extra max ammo charges (added to the level formula)
  boostSpeedMult:    number; // boost top speed
  boostRegenMult:    number; // >1 = boost gauge refills faster
  boostDurationMult: number; // >1 = boost gauge lasts longer
  rotationMult:      number; // turn rate / manoeuvrability
  rangeMult:         number; // laser range
  regenPerSec:       number; // passive self HP regen (absolute HP/s)
  teamHealPerSec:    number; // HP/s healed to nearby teammates (absolute, 0 = none)
}

/** Range (world px) within which a Support class heals teammates. */
export const SUPPORT_HEAL_RANGE = 650;

/** Defaults merged into every class entry so each definition stays terse. */
const BASE = {
  maxHpMult: 1, damageMult: 1, fireCooldownMult: 1, chargeRegenMult: 1,
  bonusCharges: 0, boostSpeedMult: 1, boostRegenMult: 1, boostDurationMult: 1,
  rotationMult: 1, rangeMult: 1, regenPerSec: 0, teamHealPerSec: 0,
};

function def(c: Pick<ShipClass, 'id' | 'name' | 'marker' | 'color' | 'blurb'> & Partial<ShipClass>): ShipClass {
  return { ...BASE, ...c };
}

export const SHIP_CLASSES: Record<ShipClassId, ShipClass> = {
  normal: def({
    id: 'normal', name: 'Standard', marker: '', color: '#cfe8ff',
    blurb: 'Balanced — no bonuses, no penalties.',
  }),

  sentinel: def({
    id: 'sentinel', name: 'Sentinel', marker: '🛡️', color: '#5fa8ff',
    blurb: 'Tank: huge HP & regen, but slow and hits softer.',
    maxHpMult: 1.4, regenPerSec: 3, damageMult: 0.85, boostSpeedMult: 0.7, rotationMult: 0.8,
  }),

  berserker: def({
    id: 'berserker', name: 'Berserker', marker: '🔥', color: '#ff5555',
    blurb: 'Glass cannon: heavy damage & fast boost, fragile hull.',
    damageMult: 1.25, boostSpeedMult: 1.2, chargeRegenMult: 1.1, maxHpMult: 0.7,
  }),

  support: def({
    id: 'support', name: 'Support', marker: '🧪', color: '#44ff99',
    blurb: 'Healer: regenerates self & nearby teammates, weak guns.',
    regenPerSec: 5, teamHealPerSec: 6, damageMult: 0.75, boostSpeedMult: 0.85, maxHpMult: 0.9,
  }),

  scout: def({
    id: 'scout', name: 'Scout', marker: '⚡', color: '#33ddff',
    blurb: 'Interceptor: blazing boost & agility, paper hull.',
    boostSpeedMult: 1.4, boostRegenMult: 1.2, boostDurationMult: 1.2, rotationMult: 1.1,
    maxHpMult: 0.65, damageMult: 0.8,
  }),

  sniper: def({
    id: 'sniper', name: 'Sniper', marker: '🎯', color: '#c08bff',
    blurb: 'Marksman: long range & big hits, slow fire & boost.',
    damageMult: 1.5, rangeMult: 1.6, fireCooldownMult: 1.25, boostSpeedMult: 0.6,
  }),

  engineer: def({
    id: 'engineer', name: 'Engineer', marker: '🧲', color: '#ffb347',
    blurb: 'Sustain: deep ammo & fast cycling, modest damage.',
    bonusCharges: 3, chargeRegenMult: 1.3, fireCooldownMult: 0.9, damageMult: 0.8, boostSpeedMult: 0.85,
  }),

  trickster: def({
    id: 'trickster', name: 'Trickster', marker: '🌀', color: '#ff7be0',
    blurb: 'Evasive: rapid fire & sharp turns, fragile.',
    rotationMult: 1.35, boostRegenMult: 1.3, fireCooldownMult: 0.85, maxHpMult: 0.75, damageMult: 0.85,
  }),

  saboteur: def({
    id: 'saboteur', name: 'Saboteur', marker: '☠️', color: '#9acd32',
    blurb: 'Harasser: fast long-range pokes, very fragile in duels.',
    fireCooldownMult: 0.8, rangeMult: 1.2, damageMult: 0.8, maxHpMult: 0.7,
  }),

  tempest: def({
    id: 'tempest', name: 'Tempest', marker: '🌪️', color: '#3fe0d0',
    blurb: 'Bruiser: sturdy & nimble area control, lower boost.',
    maxHpMult: 1.1, rotationMult: 1.15, rangeMult: 1.1, damageMult: 0.85, boostSpeedMult: 0.8,
  }),
};

/** Menu display order (Standard first). */
export const SHIP_CLASS_ORDER: ShipClassId[] = [
  'normal', 'sentinel', 'berserker', 'support', 'scout',
  'sniper', 'engineer', 'trickster', 'saboteur', 'tempest',
];

/** Resolve any (possibly undefined / unknown) id to a class, falling back to normal. */
export function shipClass(id: ShipClassId | string | undefined | null): ShipClass {
  return SHIP_CLASSES[id as ShipClassId] ?? SHIP_CLASSES.normal;
}
