// Renders one 32-bit register (or variable) as a row of bit cells, with fields,
// per-nibble hex digits, and before → after highlighting.

import { REG_BY_KEY, RegDef, hex } from '../core/chip';

const SPEED = ['in', '10MHz', '2MHz', '50MHz'];
const IN_CNF = ['analog', 'floating', 'pull-up/down', 'reserved'];
const OUT_CNF = ['push-pull', 'open-drain', 'AF push-pull', 'AF open-drain'];

export function decodePin(nibble: number) {
  const mode = nibble & 3;
  const cnf = nibble >> 2;
  return mode === 0 ? `in · ${IN_CNF[cnf]}` : `out · ${OUT_CNF[cnf]} · ${SPEED[mode]}`;
}

// 8 nibbles of 4 cells, with a narrow spacer column between nibbles.
const GRID_COLUMNS = Array.from({ length: 8 }, () => 'repeat(4, var(--cell))').join(' 7px ');

// Grid column (1-based) for bit b: 4 bit columns + 1 spacer per nibble, MSB on the left.
const col = (b: number) => {
  const p = 31 - b;
  return p + Math.floor(p / 4) + 1;
};

function el(tag: string, cls?: string, text?: string) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export interface RegViewOpts {
  key: string; // "GPIOC->CFGLR" or "var:reg" or "expr"
  before?: number; // omit for "no before"
  after: number;
  onToggle?: (bit: number) => void;
  compact?: boolean;
}

export function renderRegister(o: RegViewOpts): HTMLElement {
  const def: RegDef | undefined = REG_BY_KEY.get(o.key);
  const title = o.key === 'expr' ? 'expression' : o.key.replace(/^var:/, '');
  const box = el('div', 'reg');
  const changed = o.before !== undefined && o.before >>> 0 !== o.after >>> 0;
  if (changed) box.classList.add('reg-changed');

  // Header
  const head = el('div', 'reg-head');
  const name = el('span', 'reg-name', title);
  head.append(name);
  if (def?.access === 'ro') head.append(el('span', 'badge', 'read-only'));
  if (def?.access === 'wo') head.append(el('span', 'badge', 'write-only'));
  if (!def && o.key.startsWith('var:')) head.append(el('span', 'badge badge-var', 'variable'));
  const val = el('span', 'reg-val');
  if (o.before !== undefined && changed) {
    val.append(el('span', 'hex-before', hex(o.before)), el('span', 'arrow', ' → '), el('span', 'hex-after', hex(o.after)));
  } else {
    val.append(el('span', 'hex-after', hex(o.after)));
  }
  const dec = el('span', 'reg-dec', `= ${o.after >>> 0}${(o.after | 0) < 0 ? ` (int ${o.after | 0})` : ''}`);
  head.append(val, dec);
  box.append(head);
  if (def && !o.compact) {
    const about = el('div', 'reg-about', def.about);
    box.append(about);
  }

  // Bit grid
  const scroll = el('div', 'bits-scroll');
  const grid = el('div', 'bits');
  grid.style.gridTemplateColumns = GRID_COLUMNS;
  const port = def && def.periph.startsWith('GPIO') ? def.periph[4] : '';
  for (let b = 31; b >= 0; b--) {
    const idx = el('div', 'bit-idx', String(b));
    idx.style.gridColumn = String(col(b));
    idx.style.gridRow = '1';
    grid.append(idx);

    const now = (o.after >>> b) & 1;
    const was = o.before === undefined ? now : (o.before >>> b) & 1;
    const cell = el(o.onToggle ? 'button' : 'div', 'bit', String(now));
    cell.style.gridColumn = String(col(b));
    cell.style.gridRow = '2';
    if (now) cell.classList.add('one');
    if (now !== was) cell.classList.add(now ? 'went-up' : 'went-down');
    if (def && !((def.writable >>> b) & 1) && def.access !== 'ro') cell.classList.add('reserved');
    if (def?.name === 'INDR' && b > 7) cell.classList.add('reserved');
    const tip = [`bit ${b}`];
    const f = def?.fields.find((f) => b >= f.lsb && b < f.lsb + f.width);
    if (f) tip.push(f.name);
    if (cell.classList.contains('reserved')) tip.push('reserved');
    cell.title = tip.join(' · ');
    if (o.onToggle) {
      (cell as HTMLButtonElement).type = 'button';
      cell.addEventListener('click', () => o.onToggle!(b));
    }
    grid.append(cell);
  }

  // Hex digit under every nibble
  for (let n = 7; n >= 0; n--) {
    const d = el('div', 'nib', ((o.after >>> (n * 4)) & 0xf).toString(16).toUpperCase());
    if (o.before !== undefined && ((o.before ^ o.after) >>> (n * 4)) & 0xf) d.classList.add('nib-changed');
    d.style.gridColumn = `${col(n * 4 + 3)} / span 4`;
    d.style.gridRow = '3';
    grid.append(d);
  }

  // Fields
  if (def) {
    const row = 4;
    if (def.name === 'CFGLR') {
      for (const f of def.fields) {
        const fe = el('div', 'field', f.name.replace(/\d+$/, ''));
        fe.style.gridColumn = `${col(f.lsb + f.width - 1)} / span ${f.width}`;
        fe.style.gridRow = String(row);
        grid.append(fe);
      }
      for (let p = 7; p >= 0; p--) {
        const nib = (o.after >>> (p * 4)) & 0xf;
        const wasNib = o.before === undefined ? nib : (o.before >>> (p * 4)) & 0xf;
        const pe = el('div', 'pin-decode');
        pe.append(el('b', '', `P${port}${p}`), el('span', '', decodePin(nib)));
        if (nib !== wasNib) pe.classList.add('pin-changed');
        pe.style.gridColumn = `${col(p * 4 + 3)} / span 4`;
        pe.style.gridRow = String(row + 1);
        grid.append(pe);
      }
    } else if (port) {
      for (const f of def.fields) {
        const label = def.name === 'BSHR' ? `${f.lsb >= 16 ? 'R' : 'S'}${f.lsb % 16}` : `P${port}${f.lsb}`;
        const fe = el('div', 'field field-1', label);
        fe.style.gridColumn = String(col(f.lsb));
        fe.style.gridRow = String(row);
        grid.append(fe);
      }
    }
  }
  scroll.append(grid);
  box.append(scroll);

  // One-bit named flags (RCC): a readable list is better than tiny labels.
  if (def && def.periph === 'RCC') {
    const chips = el('div', 'flags');
    for (const f of def.fields) {
      const on = (o.after >>> f.lsb) & 1;
      const was = o.before === undefined ? on : (o.before >>> f.lsb) & 1;
      const c = el('span', 'flag' + (on ? ' flag-on' : '') + (on !== was ? ' flag-changed' : ''));
      c.append(el('i'), document.createTextNode(`${f.name} `), el('small', '', `bit ${f.lsb}`));
      chips.append(c);
    }
    box.append(chips);
  }
  return box;
}
