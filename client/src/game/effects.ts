import Phaser from 'phaser';
import { INVINCIBLE_MS } from './ui-constants';

/** Expanding ring + core + debris sparks at a world position. */
export function showExplosion(scene: Phaser.Scene, x: number, y: number): void {
  const ring = scene.add.circle(x, y, 12, 0xffffff, 0.9).setDepth(8);
  scene.tweens.add({
    targets: ring, scaleX: 9, scaleY: 9, alpha: 0,
    duration: 500, ease: 'Power2.easeOut',
    onComplete: () => ring.destroy(),
  });

  const core = scene.add.circle(x, y, 28, 0xffaa00, 1).setDepth(9);
  scene.tweens.add({
    targets: core, scaleX: 2.5, scaleY: 2.5, alpha: 0,
    duration: 280, ease: 'Power3.easeOut',
    onComplete: () => core.destroy(),
  });

  for (let i = 0; i < 8; i++) {
    const angle = (i / 8) * Math.PI * 2;
    const dist  = Phaser.Math.Between(55, 110);
    const spark = scene.add.rectangle(x, y, 3, 9, 0xff6600, 1).setDepth(8);
    scene.tweens.add({
      targets: spark,
      x: x + Math.cos(angle) * dist,
      y: y + Math.sin(angle) * dist,
      angle: Phaser.Math.Between(0, 360),
      alpha: 0,
      duration: 380, ease: 'Power1.easeOut',
      onComplete: () => spark.destroy(),
    });
  }
}

/** Small blue flash where a laser connects. */
export function showLaserHit(scene: Phaser.Scene, x: number, y: number): void {
  const flash = scene.add.circle(x, y, 8, 0x88ddff, 0.9).setDepth(8);
  scene.tweens.add({
    targets: flash, scaleX: 3, scaleY: 3, alpha: 0,
    duration: 180, ease: 'Power2.easeOut',
    onComplete: () => flash.destroy(),
  });
}

/** Green flash + rising "LEVEL n!" banner. */
export function showLevelUpEffect(scene: Phaser.Scene, level: number): void {
  const { width, height } = scene.scale;
  scene.cameras.main.flash(300, 80, 220, 80);
  const txt = scene.add.text(width / 2, height / 2 - 80, `LEVEL ${level}!`, {
    fontSize: '36px', color: '#ffdd44',
    fontFamily: 'Kenney, monospace',
    stroke: '#442200', strokeThickness: 6,
  }).setOrigin(0.5).setScrollFactor(0).setDepth(30);
  scene.tweens.add({
    targets: txt, y: height / 2 - 130, alpha: 0,
    duration: 1500, ease: 'Power2.easeOut',
    onComplete: () => txt.destroy(),
  });
}

/** Blink a target (the local ship) for `ms` of invincibility. Any in-flight blink
 *  is killed first so overlapping invuln windows (respawn + bonus) don't stack. */
export function startBlink(
  scene: Phaser.Scene,
  target: Phaser.GameObjects.Components.Alpha & Phaser.GameObjects.GameObject,
  ms = INVINCIBLE_MS,
): void {
  scene.tweens.killTweensOf(target);
  target.setAlpha(1);
  scene.tweens.add({
    targets:  target,
    alpha:    0.25,
    duration: 120,
    yoyo:     true,
    repeat:   Math.max(0, Math.round(ms / 240) - 1),
    onComplete: () => target.setAlpha(1),
  });
}

/** Cyan ring flash where a shield absorbs a hit. */
export function showShieldBlock(scene: Phaser.Scene, x: number, y: number, radius: number): void {
  const ring = scene.add.circle(x, y, radius, 0x66ddff, 0).setStrokeStyle(3, 0x66ddff, 0.9).setDepth(7);
  scene.tweens.add({
    targets: ring, scaleX: 1.4, scaleY: 1.4, alpha: 0,
    duration: 260, ease: 'Power2.easeOut',
    onComplete: () => ring.destroy(),
  });
}

/** "DESTROYED" overlay + 5-second respawn countdown; `onComplete` fires at zero. */
export function showDeathOverlay(scene: Phaser.Scene, onComplete: () => void): void {
  const { width, height } = scene.scale;
  const cx = width / 2;
  const cy = height / 2;

  const overlay = scene.add.rectangle(cx, cy, width, height, 0x000000, 0.65)
    .setScrollFactor(0).setDepth(29);

  const title = scene.add.text(cx, cy - 55, 'DESTROYED', {
    fontSize: '52px', color: '#ff3333',
    fontFamily: 'Kenney, monospace',
    stroke: '#440000', strokeThickness: 8,
  }).setOrigin(0.5).setScrollFactor(0).setDepth(30);

  const countText = scene.add.text(cx, cy + 30, '5', {
    fontSize: '80px', color: '#ffffff', fontFamily: 'Kenney, monospace',
  }).setOrigin(0.5).setScrollFactor(0).setDepth(30);

  const cleanup = () => { overlay.destroy(); title.destroy(); countText.destroy(); };

  let remaining = 5;
  const tick = () => {
    remaining--;
    if (remaining > 0) {
      countText.setText(String(remaining));
      scene.tweens.add({ targets: countText, scaleX: 1.3, scaleY: 1.3, duration: 80, yoyo: true });
      scene.time.delayedCall(1000, tick);
    } else {
      cleanup();
      onComplete();
    }
  };
  scene.time.delayedCall(1000, tick);
}
