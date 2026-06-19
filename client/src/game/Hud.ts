import Phaser from 'phaser';
import { MAX_NAME_LEN, BOOST_MIN_CHARGE } from '@shared/constants';
import type { LeaderboardEntry, BonusType } from '@shared/types';

const FONT = 'Kenney, monospace';

/**
 * Screen-pinned HUD: player count, coords, level/HP/XP bars (top-left), key
 * hints (bottom-left) and the live leaderboard (top-right). All text is
 * `setScrollFactor(0)` so it stays fixed to the screen.
 */
export class Hud {
  private players: Phaser.GameObjects.Text;
  private coords:  Phaser.GameObjects.Text;
  private level:   Phaser.GameObjects.Text;
  private hpFill:  Phaser.GameObjects.Rectangle;
  private xpFill:  Phaser.GameObjects.Rectangle;
  private ammo:    Phaser.GameObjects.Graphics;
  private bonusIcon: Phaser.GameObjects.Image;
  private bonusHint: Phaser.GameObjects.Text;
  private effects:   Phaser.GameObjects.Text;
  private hints:   Phaser.GameObjects.Text;
  private lbList:  Phaser.GameObjects.Text;
  private lbSelf:  Phaser.GameObjects.Text;
  private boostBg:    Phaser.GameObjects.Rectangle;
  private boostFill:  Phaser.GameObjects.Rectangle;
  private boostTick:  Phaser.GameObjects.Rectangle;
  private boostLabel: Phaser.GameObjects.Text;
  private readonly boostW = 200;

  constructor(private scene: Phaser.Scene) {
    const { width, height } = scene.scale;

    this.players = scene.add.text(10, 10, '', {
      fontSize: '15px', color: '#00ff88', fontFamily: FONT,
    }).setScrollFactor(0).setDepth(10);

    this.coords = scene.add.text(10, 30, '', {
      fontSize: '11px', color: '#445544', fontFamily: FONT,
    }).setScrollFactor(0).setDepth(10);

    this.level = scene.add.text(10, 50, 'Lvl 1  100 / 100', {
      fontSize: '13px', color: '#ffdd44', fontFamily: FONT,
    }).setScrollFactor(0).setDepth(10);

    scene.add.rectangle(10, 70, 120, 7, 0x221111).setOrigin(0, 0.5).setScrollFactor(0).setDepth(10);
    this.hpFill = scene.add.rectangle(10, 70, 120, 7, 0xdd3333).setOrigin(0, 0.5).setScrollFactor(0).setDepth(11);

    scene.add.rectangle(10, 81, 120, 4, 0x221100).setOrigin(0, 0.5).setScrollFactor(0).setDepth(10);
    this.xpFill = scene.add.rectangle(10, 81, 120, 4, 0xffcc00).setOrigin(0, 0.5).setScrollFactor(0).setDepth(11);

    // Fire-power gauge — segmented ammo bar (one segment per available shot).
    this.ammo = scene.add.graphics().setScrollFactor(0).setDepth(11);

    // Held bonus slot (icon + SHIFT hint) and the active-effects status line.
    this.bonusIcon = scene.add.image(28, 118, '__DEFAULT')
      .setDisplaySize(36, 36).setScrollFactor(0).setDepth(11).setVisible(false);
    this.bonusHint = scene.add.text(50, 104, 'SHIFT', {
      fontSize: '11px', color: '#88e0ff', fontFamily: FONT,
    }).setScrollFactor(0).setDepth(11).setVisible(false);
    this.effects = scene.add.text(50, 118, '', {
      fontSize: '11px', color: '#ffdd44', fontFamily: FONT,
    }).setScrollFactor(0).setDepth(11);

    // Boost gauge — bottom-centre bar (drains while boosting, refills over time).
    this.boostLabel = scene.add.text(0, 0, 'BOOST  CTRL', {
      fontSize: '11px', color: '#66ddff', fontFamily: FONT,
    }).setOrigin(0.5, 1).setScrollFactor(0).setDepth(10);
    this.boostBg = scene.add.rectangle(0, 0, this.boostW, 10, 0x07303a)
      .setOrigin(0.5, 0.5).setScrollFactor(0).setDepth(10).setStrokeStyle(1, 0x1a6b80);
    this.boostFill = scene.add.rectangle(0, 0, this.boostW, 10, 0x33ddff)
      .setOrigin(0, 0.5).setScrollFactor(0).setDepth(11);
    // Minimum-charge marker: boost can't be re-engaged left of this tick.
    this.boostTick = scene.add.rectangle(0, 0, 2, 14, 0xffffff, 0.8)
      .setOrigin(0.5, 0.5).setScrollFactor(0).setDepth(12);
    this.layoutBoost(width, height);

    this.hints = scene.add.text(10, height - 24, 'ARROWS move   SPACE fire   CTRL boost   SHIFT bonus   ESC menu', {
      fontSize: '12px', color: '#333333', fontFamily: FONT,
    }).setScrollFactor(0).setDepth(10);

    this.lbList = scene.add.text(width - 12, 10, '', {
      fontSize: '13px', color: '#88e0ff', fontFamily: FONT, align: 'right',
    }).setOrigin(1, 0).setScrollFactor(0).setDepth(10);

    this.lbSelf = scene.add.text(width - 12, 10, '', {
      fontSize: '14px', color: '#ffdd44', fontFamily: FONT, align: 'right',
    }).setOrigin(1, 0).setScrollFactor(0).setDepth(10);
  }

  setPlayers(count: number): void { this.players.setText(`Players: ${count}`); }

  /** Overwrite the player-count line with a status message (e.g. connection lost). */
  setStatus(text: string, color: string): void { this.players.setText(text).setColor(color); }

  setCoords(lon: number, lat: number): void {
    const deg = (d: number) => String(Math.round(d)).padStart(3, '0');
    this.coords.setText(`LON ${deg(lon)}°  LAT ${deg(lat)}°`);
  }

  setLevelHp(level: number, hp: number, maxHp: number): void {
    this.level.setText(`Lvl ${level}  ${hp} / ${maxHp}`);
    this.hpFill.width = 120 * (maxHp > 0 ? Math.max(0, hp / maxHp) : 0);
  }

  setXp(xp: number, xpMax: number): void {
    this.xpFill.width = 120 * (xpMax > 0 ? Math.max(0, Math.min(1, xp / xpMax)) : 0);
  }

  /** Segmented fire-power gauge: one bright segment per ready shot, the
   *  regenerating shot shown as a partial fill. */
  setAmmo(charges: number, maxCharges: number): void {
    const W = 120, H = 6, x0 = 10, y0 = 90, gap = 2;
    const segW = (W - gap * (maxCharges - 1)) / maxCharges;
    const g = this.ammo;
    g.clear();
    for (let i = 0; i < maxCharges; i++) {
      const x = x0 + i * (segW + gap);
      g.fillStyle(0x0a2418, 1).fillRect(x, y0, segW, H);
      const fill = Math.max(0, Math.min(1, charges - i));
      if (fill > 0) {
        g.fillStyle(fill >= 1 ? 0x33ffaa : 0x1f8f66, 1).fillRect(x, y0, segW * fill, H);
      }
    }
  }

  /** Show the held bonus icon (or hide the slot when empty). */
  setHeldBonus(kind: BonusType | null): void {
    if (kind) {
      this.bonusIcon.setTexture(`bonus_${kind}`).setDisplaySize(36, 36).setVisible(true);
      this.bonusHint.setVisible(true);
    } else {
      this.bonusIcon.setVisible(false);
      this.bonusHint.setVisible(false);
    }
  }

  /** One-line summary of currently-active power-up effects (empty string clears it). */
  setEffects(text: string): void { this.effects.setText(text); }

  /** Boost gauge fill (charge 0..1). Orange while boosting, cyan when ready to
   *  engage, dim red while still below the minimum-charge threshold. */
  setBoost(charge: number, active: boolean, ready: boolean): void {
    const c = Math.max(0, Math.min(1, charge));
    this.boostFill.width = this.boostW * c;
    this.boostFill.setFillStyle(active ? 0xff8822 : ready ? 0x33ddff : 0x884444);
  }

  /** Position the boost bar/label/threshold-tick centred along the bottom of the screen. */
  private layoutBoost(width: number, height: number): void {
    const bx = width / 2, by = height - 46;
    this.boostLabel.setPosition(bx, by - 9);
    this.boostBg.setPosition(bx, by);
    this.boostFill.setPosition(bx - this.boostW / 2, by);
    this.boostTick.setPosition(bx - this.boostW / 2 + this.boostW * BOOST_MIN_CHARGE, by);
  }

  setLeaderboard(top: LeaderboardEntry[], rank: number, score: number, total: number): void {
    const pad = (s: string, n: number) => (s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length));
    const rows = top.map((e, i) => {
      const marker = e.me ? '▶' : ' ';   // ▶ marks your own row (same width as a space)
      return `${marker}${String(i + 1).padStart(2)}. ${pad(e.name, MAX_NAME_LEN)} ${String(e.score).padStart(4)}`;
    });
    this.lbList.setText(['— TOP PILOTS —', ...rows].join('\n'));
    this.lbSelf
      .setText(`#${rank} / ${total}    ${score} pts`)
      .setPosition(this.scene.scale.width - 12, this.lbList.y + this.lbList.height + 8);
  }

  resize(width: number, height: number): void {
    this.layoutBoost(width, height);
    this.hints.setPosition(10, height - 24);
    this.lbList.setPosition(width - 12, 10);
    this.lbSelf.setPosition(width - 12, this.lbList.y + this.lbList.height + 8);
  }
}
