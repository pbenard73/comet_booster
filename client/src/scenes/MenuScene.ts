import Phaser from 'phaser';
import { MAX_NAME_LEN } from '@shared/constants';

const PSEUDO_KEY = 'comet_pseudo';

export class MenuScene extends Phaser.Scene {
  private pseudo   = '';
  private cursorOn = true;
  private nameText!: Phaser.GameObjects.Text;

  constructor() { super('Menu'); }

  create(): void {
    const { width, height } = this.scale;
    const cx = width / 2;
    const cy = height / 2;

    const stars = this.add.graphics();
    for (let i = 0; i < 160; i++) {
      const x = Phaser.Math.Between(0, width);
      const y = Phaser.Math.Between(0, height);
      const r = Phaser.Math.FloatBetween(0.3, 1.0);
      stars.fillStyle(0xffffff, Phaser.Math.FloatBetween(0.2, 0.7));
      stars.fillCircle(x, y, r);
    }

    this.add.text(cx, cy - 130, 'COMET BOOSTER', {
      fontSize:        '52px',
      color:           '#00ffff',
      fontFamily:      'Kenney, monospace',
      stroke:          '#003333',
      strokeThickness: 6,
    }).setOrigin(0.5);

    this.add.text(cx, cy - 80, 'Multiplayer Space Arena', {
      fontSize: '18px', color: '#888888', fontFamily: 'Kenney, monospace',
    }).setOrigin(0.5);

    this.add.text(cx, cy - 16, 'ENTER YOUR CALLSIGN', {
      fontSize: '16px', color: '#00ffaa', fontFamily: 'Kenney, monospace',
    }).setOrigin(0.5);

    this.add.rectangle(cx, cy + 24, 340, 46, 0x001a1a, 0.6)
      .setStrokeStyle(2, 0x00ffff, 0.5);

    this.nameText = this.add.text(cx, cy + 24, '', {
      fontSize: '24px', color: '#ffffff', fontFamily: 'Kenney, monospace',
    }).setOrigin(0.5);

    this.pseudo = (localStorage.getItem(PSEUDO_KEY) ?? '').slice(0, MAX_NAME_LEN);
    this.renderName();

    const hint = this.add.text(cx, cy + 80, '[ ENTER to launch ]', {
      fontSize: '20px', color: '#ffffff', fontFamily: 'Kenney, monospace',
    }).setOrigin(0.5);
    this.tweens.add({
      targets: hint, alpha: 0.3, duration: 700, yoyo: true, repeat: -1, ease: 'Sine.easeInOut',
    });

    this.add.text(cx, height - 30, 'ARROWS: thrust & rotate   SPACE: fire', {
      fontSize: '13px', color: '#444444', fontFamily: 'Kenney, monospace',
    }).setOrigin(0.5);

    // Blinking caret
    this.time.addEvent({
      delay: 450, loop: true,
      callback: () => { this.cursorOn = !this.cursorOn; this.renderName(); },
    });

    this.input.keyboard!.on('keydown', this.onKey, this);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.input.keyboard!.off('keydown', this.onKey, this);
    });
  }

  private renderName(): void {
    this.nameText.setText(this.pseudo + (this.cursorOn ? '|' : ' '));
  }

  private onKey(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      event.preventDefault();
      this.launch();
      return;
    }
    if (event.key === 'Backspace') {
      event.preventDefault();
      this.pseudo = this.pseudo.slice(0, -1);
      this.renderName();
      return;
    }
    // Printable, restricted character set — keeps names clean and renderable.
    if (event.key.length === 1 && /[A-Za-z0-9 _\-]/.test(event.key) && this.pseudo.length < MAX_NAME_LEN) {
      event.preventDefault();
      this.pseudo += event.key;
      this.renderName();
    }
  }

  private launch(): void {
    let name = this.pseudo.trim();
    if (!name) name = 'Pilot' + Math.floor(100 + Math.random() * 900);
    localStorage.setItem(PSEUDO_KEY, name);
    this.scene.start('Game', { name });
  }
}
