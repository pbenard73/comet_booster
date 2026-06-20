/**
 * In-game team-invite confirmation popup, built as a DOM overlay over the Phaser
 * canvas. When an invite arrives the target sees this with a 10 s countdown; the
 * host freezes & shields the ship while it is up (see GameScene.inviteFreeze).
 *
 *   answered (Accept/Decline) → onRespond  (host keeps a 2 s invuln grace)
 *   10 s timeout              → onExpire    (host grants no grace)
 */
import { cometUiClass } from '../dom';

export interface InvitePopupDeps {
  onRespond: (fromId: number, accept: boolean) => void;
  onExpire:  (fromId: number) => void;
}

const FONT = "'Kenney', monospace";
const INVITE_TIMEOUT_MS = 10000;

export class InvitePopup {
  private root:  HTMLDivElement;
  private popup: HTMLDivElement;
  private timer = 0;
  private fromId = -1;
  private countdownEl: HTMLDivElement | null = null;

  constructor(private deps: InvitePopupDeps) {
    this.root = document.createElement('div');
    this.root.className = cometUiClass();
    Object.assign(this.root.style, {
      position: 'fixed', inset: '0', pointerEvents: 'none', zIndex: '1000',
      fontFamily: FONT, color: '#cfe8ff',
    } as CSSStyleDeclaration);

    this.popup = document.createElement('div');
    Object.assign(this.popup.style, {
      position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%,-50%)',
      minWidth: '300px', padding: '18px', background: 'rgba(0,20,26,0.96)',
      border: '2px solid #33ff66', borderRadius: '8px', pointerEvents: 'auto',
      display: 'none', textAlign: 'center', boxShadow: '0 0 30px rgba(51,255,102,0.3)',
    } as CSSStyleDeclaration);
    this.root.appendChild(this.popup);
    document.body.appendChild(this.root);
  }

  show(fromId: number, fromName: string): void {
    this.clearTimer();
    this.fromId = fromId;
    this.popup.innerHTML = '';

    const msg = document.createElement('div');
    msg.innerHTML = `<b style="color:#33ff66">${escapeHtml(fromName)}</b> wants to team up with you`;
    Object.assign(msg.style, { fontSize: '15px', marginBottom: '12px' } as CSSStyleDeclaration);
    this.popup.appendChild(msg);

    const row = document.createElement('div');
    Object.assign(row.style, { display: 'flex', gap: '10px', justifyContent: 'center' } as CSSStyleDeclaration);
    row.appendChild(this.button('Accept',  '#33ff66', '#001a1a', () => this.resolve(true)));
    row.appendChild(this.button('Decline', '#ff5566', '#fff',     () => this.resolve(false)));
    this.popup.appendChild(row);

    // Countdown: answer within 10 s or the window closes (invincibility is lost).
    this.countdownEl = document.createElement('div');
    Object.assign(this.countdownEl.style, { color: '#88a', fontSize: '12px', marginTop: '12px' } as CSSStyleDeclaration);
    this.popup.appendChild(this.countdownEl);

    const deadline = Date.now() + INVITE_TIMEOUT_MS;
    const tick = () => {
      const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      if (this.countdownEl) this.countdownEl.textContent = `Respond within ${left}s`;
      if (left <= 0) this.expire();
    };
    tick();
    this.timer = window.setInterval(tick, 250);
    this.popup.style.display = 'block';
  }

  private resolve(accept: boolean): void {
    const from = this.fromId;
    this.close();
    if (from >= 0) this.deps.onRespond(from, accept);
  }

  private expire(): void {
    const from = this.fromId;
    this.close();
    if (from >= 0) this.deps.onExpire(from);
  }

  private close(): void {
    this.clearTimer();
    this.fromId = -1;
    this.popup.style.display = 'none';
  }

  private clearTimer(): void {
    window.clearInterval(this.timer);
    this.timer = 0;
    this.countdownEl = null;
  }

  private button(text: string, bg: string, fg: string, onClick: () => void): HTMLButtonElement {
    const b = document.createElement('button');
    b.textContent = text;
    Object.assign(b.style, {
      padding: '8px 18px', fontFamily: FONT, fontSize: '14px', color: fg,
      background: bg, border: 'none', borderRadius: '4px', cursor: 'pointer',
    } as CSSStyleDeclaration);
    b.addEventListener('click', onClick);
    return b;
  }

  destroy(): void {
    this.clearTimer();
    this.root.remove();
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
