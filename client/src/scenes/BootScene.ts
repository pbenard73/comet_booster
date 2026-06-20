import Phaser from 'phaser';
import { SHIP_COUNT } from '@shared/constants';
import { BONUS_KINDS } from '@shared/types';

export class BootScene extends Phaser.Scene {
  constructor() { super('Boot'); }

  preload(): void {
    const { width, height } = this.scale;

    const bar = this.add.graphics();
    this.load.on('progress', (v: number) => {
      bar.clear()
        .fillStyle(0x111111).fillRect(width / 4 - 2, height / 2 - 12, width / 2 + 4, 24)
        .fillStyle(0x00ffff).fillRect(width / 4, height / 2 - 10, (width / 2) * v, 20);
    });
    this.load.on('complete', () => bar.destroy());

    // Ship sprite pool — one is assigned per player by the server (stable id → sprite).
    // The sprite files are 1-indexed (sprite_0001…), so ship_i maps to sprite_{i+1}.
    for (let i = 0; i < SHIP_COUNT; i++) {
      this.load.image(`ship_${i}`, `/assets/ships/sprite_${String(i + 1).padStart(4, '0')}.png`);
    }

    // Bonus power-up icons (texture key `bonus_<kind>`)
    for (const kind of BONUS_KINDS) {
      this.load.image(`bonus_${kind}`, `/assets/bonus/${kind}.png`);
    }

    // Thruster fire frames
    for (let i = 0; i < 20; i++) {
      const key = `fire${String(i).padStart(2, '0')}`;
      this.load.image(key, `/assets/effects/${key}.png`);
    }

    // Audio
    this.load.audio('sfx_laser', '/assets/audio/sfx_laser1.ogg');
    this.load.audio('sfx_join',  '/assets/audio/sfx_twoTone.ogg');
    this.load.audio('sfx_lose',  '/assets/audio/sfx_lose.ogg');
    this.load.audio('sfx_deflect', '/assets/audio/sfx_laser2.ogg');  // "bong" — laser hitting a refuge force field
  }

  create(): void {
    this.anims.create({
      key:       'thruster',
      frames:    Array.from({ length: 20 }, (_, i) => ({ key: `fire${String(i).padStart(2, '0')}` })),
      frameRate: 24,
      repeat:    -1,
    });

    this.scene.start('Menu');
  }
}
