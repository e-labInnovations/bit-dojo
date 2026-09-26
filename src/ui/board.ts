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

// CH32V003F4P6 (TSSOP-20) pinout, top to bottom. Left = pins 1–10, right = pins 20–11.
const LEFT_PINS = ['PD4', 'PD5', 'PD6', 'PD7', 'PA1', 'PA2', 'VSS', 'PD0', 'VDD', 'PC0'];
const RIGHT_PINS = ['PD3', 'PD2', 'PD1', 'PC7', 'PC6', 'PC5', 'PC4', 'PC3', 'PC2', 'PC1'];
const PD2_ROW = RIGHT_PINS.indexOf('PD2');
const PC1_ROW = RIGHT_PINS.indexOf('PC1');
const ROW = (i: number) => 32.5 + i * 11; // y centre of pin row i

function chipSvg(): string {
  const pads = LEFT_PINS.map((_, i) => `<rect x="38" y="${ROW(i) - 2.5}" width="10" height="5" class="pin"/>`).join('') +
    RIGHT_PINS.map((_, i) => `<rect x="136" y="${ROW(i) - 2.5}" width="10" height="5" class="pin${i === PD2_ROW || i === PC1_ROW ? ' pin-used' : ''}"/>`).join('');
  const labels = LEFT_PINS.map((n, i) => `<text x="50" y="${ROW(i) + 2.3}" class="pin-name">${n}</text>`).join('') +
    RIGHT_PINS.map((n, i) => `<text x="134" y="${ROW(i) + 2.3}" class="pin-name pin-name-r${i === PD2_ROW || i === PC1_ROW ? ' pin-name-used' : ''}">${n}</text>`).join('');
  return `${pads}
      <rect x="46" y="22" width="92" height="120" rx="3" class="chip-body"/>
      <path d="M86 22 a6 6 0 0 0 12 0" class="chip-notch"/>
      ${labels}
      <text x="92" y="80" class="chip-text">CH32V003</text>
      <text x="92" y="91" class="chip-sub">F4P6</text>`;
}

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
  <svg viewBox="0 0 360 180" role="img" aria-label="Board: LED ${led}, button ${pressed ? 'pressed' : 'released'}">
    <defs>
      <radialGradient id="glow" cx="50%" cy="50%" r="50%">
        <stop offset="0%" stop-color="var(--led)" stop-opacity=".9"/>
        <stop offset="100%" stop-color="var(--led)" stop-opacity="0"/>
      </radialGradient>
    </defs>
    <rect x="4" y="4" width="352" height="172" rx="10" class="pcb"/>
    <g class="chip">
      ${chipSvg()}
    </g>
    <!-- Traces first, so the parts sit on top of them. Each trace runs to the part's centre. -->
    <path d="M146 ${ROW(PD2_ROW)} H270" class="trace trace-pd2"/>
    <path d="M270 ${ROW(PD2_ROW)} H320 V62" class="trace"/>
    <path d="M146 ${ROW(PC1_ROW)} H272" class="trace trace-pc1"/>
    <path d="M272 ${ROW(PC1_ROW)} H320 V150" class="trace"/>
    <text x="152" y="${ROW(PD2_ROW) - 6}" class="pin-label">PD2</text>
    <text x="152" y="${ROW(PC1_ROW) - 6}" class="pin-label">PC1</text>
    <text x="316" y="76" class="gnd">GND</text>
    <text x="316" y="164" class="gnd">GND</text>
    <!-- PD2 (pin 19) → button → GND -->
    <g class="btn" ${o.interactive ? 'role="button" tabindex="0" aria-label="Press button on PD2"' : ''}>
      <rect x="250" y="${ROW(PD2_ROW) - 16}" width="40" height="32" rx="4" class="btn-base"/>
      <circle cx="270" cy="${ROW(PD2_ROW)}" r="${pressed ? 9 : 11}" class="btn-cap"/>
    </g>
    <!-- PC1 (pin 11) → resistor → LED → GND -->
    <rect x="190" y="${ROW(PC1_ROW) - 5}" width="26" height="10" rx="2" class="resistor"/>
    <circle cx="272" cy="${ROW(PC1_ROW)}" r="26" fill="url(#glow)" class="led-glow"/>
    <circle cx="272" cy="${ROW(PC1_ROW)}" r="10" class="led"/>
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
