/**
 * Start-screen ship-class selection — a DOM modal shown after the pilot enters
 * their callsign and before the team prompt. Lists every class from the shared
 * registry (SHIP_CLASS_ORDER) with its marker, name and one-line blurb; the chosen
 * class id is returned via `onChoose`. "Standard" (normal) is the no-bonus default.
 * The class is sent to the server once the pilot spawns (see GameScene init).
 */
import { cometUiClass } from '../dom';
import { SHIP_CLASSES, SHIP_CLASS_ORDER, type ShipClassId } from '@shared/classes';

const FONT = "'Kenney', monospace";

export class ClassSelect {
  private root:  HTMLDivElement;
  private modal: HTMLDivElement;
  private onChoose: ((cls: ShipClassId) => void) | null = null;

  constructor() {
    this.root = document.createElement('div');
    this.root.className = cometUiClass();
    Object.assign(this.root.style, {
      position: 'fixed', inset: '0', display: 'none', zIndex: '1000',
      background: 'rgba(0,8,12,0.6)', fontFamily: FONT, color: '#cfe8ff',
    } as CSSStyleDeclaration);

    this.modal = document.createElement('div');
    Object.assign(this.modal.style, {
      position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%,-50%)',
      width: '420px', maxWidth: '92vw', maxHeight: '88vh', overflowY: 'auto',
      padding: '20px', background: 'rgba(0,20,26,0.96)',
      border: '2px solid #00ffff', borderRadius: '8px',
      boxShadow: '0 0 28px rgba(0,255,255,0.25)', textAlign: 'center',
    } as CSSStyleDeclaration);
    this.root.appendChild(this.modal);
    document.body.appendChild(this.root);
  }

  open(onChoose: (cls: ShipClassId) => void): void {
    this.onChoose = onChoose;
    this.root.style.display = 'block';
    this.render();
  }

  private render(): void {
    this.modal.innerHTML = '';

    const title = document.createElement('div');
    title.textContent = 'CHOOSE YOUR CLASS';
    Object.assign(title.style, { color: '#00ffaa', fontSize: '16px', letterSpacing: '1px', marginBottom: '14px' } as CSSStyleDeclaration);
    this.modal.appendChild(title);

    for (const id of SHIP_CLASS_ORDER) {
      this.modal.appendChild(this.classRow(id));
    }
  }

  private classRow(id: ShipClassId): HTMLButtonElement {
    const c = SHIP_CLASSES[id];
    const btn = document.createElement('button');
    Object.assign(btn.style, {
      display: 'block', width: '100%', boxSizing: 'border-box', marginBottom: '8px',
      padding: '8px 12px', fontFamily: FONT, textAlign: 'left', cursor: 'pointer',
      color: '#fff', background: 'rgba(0,40,52,0.7)',
      border: `1px solid ${c.color}`, borderRadius: '6px',
    } as CSSStyleDeclaration);
    btn.addEventListener('mouseenter', () => { btn.style.background = 'rgba(0,70,90,0.9)'; });
    btn.addEventListener('mouseleave', () => { btn.style.background = 'rgba(0,40,52,0.7)'; });

    const head = document.createElement('div');
    head.textContent = `${c.marker ? c.marker + ' ' : ''}${c.name}`;
    Object.assign(head.style, { color: c.color, fontSize: '15px', marginBottom: '3px' } as CSSStyleDeclaration);

    const blurb = document.createElement('div');
    blurb.textContent = c.blurb;
    Object.assign(blurb.style, { color: '#9fc4d4', fontSize: '11px', lineHeight: '1.3' } as CSSStyleDeclaration);

    btn.appendChild(head);
    btn.appendChild(blurb);
    btn.addEventListener('click', () => this.choose(id));
    return btn;
  }

  private choose(cls: ShipClassId): void {
    this.root.style.display = 'none';
    const cb = this.onChoose;
    this.onChoose = null;
    cb?.(cls);
  }

  destroy(): void {
    this.root.remove();
  }
}
