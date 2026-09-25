// Tiny board drawing: CH32V003 with an LED on PC1 and a button from PD2 to GND.

import { Chip, Drive } from '../core/chip';

const DRIVE_TEXT: Record<Drive, string> = {
  high: 'driving HIGH',
  low: 'driving LOW',
  hiz: 'hi-Z (not driven)',
  'pull-up': 'input, pull-up',
  'pull-down': 'input, pull-down',
  af: 'alternate function',
  off: 'port clock OFF',
};

export interface BoardOpts {
  chip: Chip;
  interactive?: boolean;
  onPress?: (down: boolean) => void;
}

export function renderBoard(o: BoardOpts): HTMLElement {
  const pc1 = o.chip.drive('GPIOC', 1);
  const pd2 = o.chip.drive('GPIOD', 2);
  const pressed = o.chip.state.external.PD2 === 'low';
  const led = pc1 === 'high' ? 'on' : pc1 === 'pull-up' ? 'dim' : 'off';
  const pd2Level = o.chip.clockOn('GPIOD') ? (o.chip.inputs('GPIOD') >> 2) & 1 : null;

  const wrap = document.createElement('div');
  wrap.className = `board led-${led}${pressed ? ' pressed' : ''}${o.interactive ? ' interactive' : ''}`;
  wrap.innerHTML = `
  <svg viewBox="0 0 360 170" role="img" aria-label="Board: LED ${led}, button ${pressed ? 'pressed' : 'released'}">
    <defs>
      <radialGradient id="glow" cx="50%" cy="50%" r="50%">
        <stop offset="0%" stop-color="var(--led)" stop-opacity=".9"/>
        <stop offset="100%" stop-color="var(--led)" stop-opacity="0"/>
      </radialGradient>
    </defs>
    <rect x="4" y="4" width="352" height="162" rx="10" class="pcb"/>
    <g class="chip">
      ${Array.from({ length: 10 }, (_, i) => `<rect x="44" y="${30 + i * 11}" width="10" height="5" class="pin"/><rect x="126" y="${30 + i * 11}" width="10" height="5" class="pin"/>`).join('')}
      <rect x="52" y="22" width="76" height="120" rx="3" class="chip-body"/>
      <circle cx="62" cy="32" r="3" class="chip-dot"/>
      <text x="90" y="78" class="chip-text">CH32V003</text>
      <text x="90" y="92" class="chip-sub">F4P6</text>
    </g>
    <!-- PC1 → resistor → LED → GND -->
    <path d="M136 43 H170 V38 H250" class="trace trace-pc1"/>
    <text x="142" y="36" class="pin-label">PC1</text>
    <rect x="186" y="33" width="26" height="10" rx="2" class="resistor"/>
    <circle cx="272" cy="38" r="26" fill="url(#glow)" class="led-glow"/>
    <circle cx="272" cy="38" r="10" class="led"/>
    <path d="M282 38 H320 V62" class="trace"/>
    <text x="316" y="76" class="gnd">GND</text>
    <!-- PD2 → button → GND -->
    <path d="M136 108 H250" class="trace trace-pd2"/>
    <text x="142" y="102" class="pin-label">PD2</text>
    <g class="btn" ${o.interactive ? 'role="button" tabindex="0" aria-label="Press button on PD2"' : ''}>
      <rect x="250" y="92" width="40" height="32" rx="4" class="btn-base"/>
      <circle cx="270" cy="108" r="${pressed ? 9 : 11}" class="btn-cap"/>
    </g>
    <path d="M290 108 H320 V132" class="trace"/>
    <text x="316" y="146" class="gnd">GND</text>
  </svg>
  <div class="board-status">
    <div><b>PC1</b> ${DRIVE_TEXT[pc1]} → LED <b class="st-${led}">${led === 'dim' ? 'faint glow' : led.toUpperCase()}</b></div>
    <div><b>PD2</b> ${DRIVE_TEXT[pd2]}, button ${pressed ? '<b>pressed</b>' : 'released'}${pd2Level === null ? '' : ` → INDR bit 2 = <b>${pd2Level}</b>`}</div>
  </div>`;
  if (led === 'dim') {
    wrap.querySelector('.board-status')!.insertAdjacentHTML('beforeend', '<div class="muted">The pull-up leaks ~0.1 mA through the LED — real boards glow faintly like this.</div>');
  }

  if (o.interactive && o.onPress) {
    // The board re-renders on press, so release is listened for on window, not on this element.
    const btn = wrap.querySelector<SVGGElement>('.btn')!;
    const up = () => o.onPress!(false);
    btn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      window.addEventListener('pointerup', up, { once: true });
      o.onPress!(true);
    });
    btn.addEventListener('keydown', (e) => {
      if ((e.key !== ' ' && e.key !== 'Enter') || e.repeat) return;
      e.preventDefault();
      window.addEventListener('keyup', up, { once: true });
      o.onPress!(true);
    });
  }
  return wrap;
}
