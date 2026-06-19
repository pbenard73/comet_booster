import Phaser from 'phaser';

/**
 * Screen-locked, infinitely tiled starfield. A small star patch is baked into a
 * texture once, then tiled across one GPU-culled quad; `scroll()` slides the tile
 * to follow the ship's continuous position so the field never shows a seam — even
 * as the ship roams past the torus bounds. A multi-circle Graphics re-tessellates
 * every primitive each frame and was the dominant render cost.
 */
export class Starfield {
  private tile: Phaser.GameObjects.TileSprite;

  constructor(private scene: Phaser.Scene) {
    const TILE = 1024;
    const g = scene.make.graphics(undefined, false);
    for (let i = 0; i < 40; i++) {
      const x     = Phaser.Math.Between(0, TILE);
      const y     = Phaser.Math.Between(0, TILE);
      const r     = Phaser.Math.FloatBetween(0.4, 1.2);
      const alpha = Phaser.Math.FloatBetween(0.25, 0.75);
      g.fillStyle(0xffffff, alpha).fillCircle(x, y, r);
    }
    g.generateTexture('starfield_tile', TILE, TILE);
    g.destroy();

    this.tile = scene.add
      .tileSprite(0, 0, scene.scale.width, scene.scale.height, 'starfield_tile')
      .setOrigin(0, 0)
      .setScrollFactor(0)
      .setDepth(0);
  }

  /** Slide the field to match the camera (centred on the ship). */
  scroll(shipX: number, shipY: number): void {
    this.tile.tilePositionX = shipX - this.scene.scale.width / 2;
    this.tile.tilePositionY = shipY - this.scene.scale.height / 2;
  }

  resize(width: number, height: number): void {
    this.tile.setSize(width, height);
  }
}
