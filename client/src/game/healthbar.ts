import Phaser from 'phaser';
import { HP_BAR_W, HP_BAR_H } from './ui-constants';

/**
 * Draw a small HP bar just above a ship (into the shared `g` Graphics) and
 * return the Y at which the name label should sit, just above the bar.
 */
export function drawHpBar(
  g: Phaser.GameObjects.Graphics,
  cx: number, shipTop: number, hp: number, maxHp: number,
): number {
  const pct   = maxHp > 0 ? Phaser.Math.Clamp(hp / maxHp, 0, 1) : 0;
  const barCY = shipTop - 4 - HP_BAR_H / 2;
  const x     = cx - HP_BAR_W / 2;
  const y     = barCY - HP_BAR_H / 2;

  g.fillStyle(0x000000, 0.55).fillRect(x - 1, y - 1, HP_BAR_W + 2, HP_BAR_H + 2);
  g.fillStyle(0x3a1414, 1).fillRect(x, y, HP_BAR_W, HP_BAR_H);
  if (pct > 0) {
    const col = pct > 0.5 ? 0x33dd55 : pct > 0.25 ? 0xddcc33 : 0xdd3333;
    g.fillStyle(col, 1).fillRect(x, y, HP_BAR_W * pct, HP_BAR_H);
  }
  return barCY - HP_BAR_H / 2 - 2;   // name label bottom sits just above the bar
}
