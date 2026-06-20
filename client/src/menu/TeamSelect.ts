/**
 * Start-screen team selection, a DOM modal shown after the pilot enters their
 * callsign. Step 1 asks whether to join a team; if yes, step 2 searches online
 * players (HTTP `/api/players?q=` — the menu has no WebSocket) and lets the pilot
 * pick one. The chosen target id (or null for solo) is returned via `onChoose`;
 * the actual invite is sent once the pilot spawns into the game.
 */
import { cometUiClass } from '../dom';

const FONT = "'Kenney', monospace";

export class TeamSelect {
  private root:    HTMLDivElement;
  private modal:   HTMLDivElement;
  private onChoose: ((targetId: number | null) => void) | null = null;
  private searchTimer = 0;

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
      width: '340px', maxWidth: '90vw', maxHeight: '90vh', overflowY: 'auto',
      padding: '20px', background: 'rgba(0,20,26,0.96)',
      border: '2px solid #00ffff', borderRadius: '8px',
      boxShadow: '0 0 28px rgba(0,255,255,0.25)', textAlign: 'center',
    } as CSSStyleDeclaration);
    this.root.appendChild(this.modal);
    document.body.appendChild(this.root);
  }

  open(onChoose: (targetId: number | null) => void): void {
    this.onChoose = onChoose;
    this.root.style.display = 'block';
    this.showPrompt();
  }

  // ── Step 1: join a team? ─────────────────────────────────────────────────────

  private showPrompt(): void {
    this.modal.innerHTML = '';
    this.modal.appendChild(this.title('JOIN A TEAM?'));

    const row = document.createElement('div');
    Object.assign(row.style, { display: 'flex', gap: '10px', justifyContent: 'center', marginTop: '6px' } as CSSStyleDeclaration);
    row.appendChild(this.button('Yes',          '#00ffaa', '#001a1a', () => this.showSearch()));
    row.appendChild(this.button('No, play solo', '#334',    '#cfe8ff', () => this.choose(null)));
    this.modal.appendChild(row);
  }

  // ── Step 2: find a teammate ──────────────────────────────────────────────────

  private showSearch(): void {
    this.modal.innerHTML = '';
    this.modal.appendChild(this.title('FIND A TEAMMATE'));

    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = 'search callsign…';
    input.maxLength = 24;
    Object.assign(input.style, {
      width: '100%', boxSizing: 'border-box', padding: '8px', fontFamily: FONT,
      fontSize: '15px', color: '#fff', background: '#001a1a',
      border: '1px solid rgba(0,255,255,0.5)', borderRadius: '4px', outline: 'none',
    } as CSSStyleDeclaration);

    const results = document.createElement('div');
    Object.assign(results.style, { marginTop: '8px', maxHeight: '220px', overflowY: 'auto', textAlign: 'left' } as CSSStyleDeclaration);

    input.addEventListener('input', () => {
      window.clearTimeout(this.searchTimer);
      this.searchTimer = window.setTimeout(() => this.runSearch(input.value.trim(), results), 180);
    });

    this.modal.appendChild(input);
    this.modal.appendChild(results);

    const solo = this.button('Play solo', '#334', '#cfe8ff', () => this.choose(null));
    Object.assign(solo.style, { marginTop: '12px' } as CSSStyleDeclaration);
    this.modal.appendChild(solo);

    setTimeout(() => input.focus(), 0);
  }

  private async runSearch(q: string, results: HTMLDivElement): Promise<void> {
    results.innerHTML = '';
    if (!q) return;
    let matches: Array<{ id: number; name: string }> = [];
    try {
      const r = await fetch(`/api/players?q=${encodeURIComponent(q)}`);
      matches = await r.json();
    } catch {
      results.appendChild(this.note('Search unavailable'));
      return;
    }
    if (matches.length === 0) {
      results.appendChild(this.note('No players found'));
      return;
    }
    for (const m of matches) {
      const rowEl = document.createElement('div');
      Object.assign(rowEl.style, {
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '6px 4px', borderBottom: '1px solid rgba(0,255,255,0.12)',
      } as CSSStyleDeclaration);

      const name = document.createElement('span');
      name.textContent = m.name;
      Object.assign(name.style, { fontSize: '14px', color: '#fff', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } as CSSStyleDeclaration);

      const btn = this.button('Associate', '#00ffaa', '#001a1a', () => this.choose(m.id));
      Object.assign(btn.style, { marginLeft: '8px', padding: '4px 10px', fontSize: '12px' } as CSSStyleDeclaration);

      rowEl.appendChild(name);
      rowEl.appendChild(btn);
      results.appendChild(rowEl);
    }
  }

  // ── Shared ───────────────────────────────────────────────────────────────────

  private choose(targetId: number | null): void {
    window.clearTimeout(this.searchTimer);
    this.root.style.display = 'none';
    const cb = this.onChoose;
    this.onChoose = null;
    cb?.(targetId);
  }

  private title(text: string): HTMLDivElement {
    const t = document.createElement('div');
    t.textContent = text;
    Object.assign(t.style, { color: '#00ffaa', fontSize: '15px', letterSpacing: '1px', marginBottom: '14px' } as CSSStyleDeclaration);
    return t;
  }

  private note(text: string): HTMLDivElement {
    const n = document.createElement('div');
    n.textContent = text;
    Object.assign(n.style, { color: '#557', fontSize: '12px', padding: '6px 2px' } as CSSStyleDeclaration);
    return n;
  }

  private button(text: string, bg: string, fg: string, onClick: () => void): HTMLButtonElement {
    const b = document.createElement('button');
    b.textContent = text;
    Object.assign(b.style, {
      padding: '8px 16px', fontFamily: FONT, fontSize: '14px', color: fg,
      background: bg, border: 'none', borderRadius: '4px', cursor: 'pointer',
    } as CSSStyleDeclaration);
    b.addEventListener('click', onClick);
    return b;
  }

  destroy(): void {
    window.clearTimeout(this.searchTimer);
    this.root.remove();
  }
}
