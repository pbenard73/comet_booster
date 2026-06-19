import Phaser from 'phaser';
import { BootScene } from './scenes/BootScene';
import { MenuScene } from './scenes/MenuScene';
import { GameScene } from './scenes/GameScene';

new Phaser.Game({
  type:            Phaser.AUTO,
  backgroundColor: '#000000',
  scale: {
    mode:       Phaser.Scale.RESIZE,
    autoCenter: Phaser.Scale.CENTER_BOTH,
  },
  physics: {
    default: 'arcade',
    arcade:  { debug: false },
  },
  scene: [BootScene, MenuScene, GameScene],
});
