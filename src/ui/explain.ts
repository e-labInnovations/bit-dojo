// Step-by-step, animated view of how C evaluated an expression, one operator at a time.
// Shifts slide the bits, &/|/^/~ sweep column by column, everything shows its binary.

import type { Note } from '../core/chip';
import type { Operand, Step, Val } from '../core/interp';

const CANCEL = Symbol('cancel');

const OP_NAME: Record<string, string> = {
  '<<': 'shift left', '>>': 'shift right', '&': 'AND', '|': 'OR', '^': 'XOR', '~': 'NOT', '!': 'logical NOT',
  '-': 'minus', '+': 'plus', '*': 'times', '/': 'divide', '%': 'remainder',
  '==': 'equals', '!=': 'not equal', '<': 'less than', '<=': 'at most', '>': 'greater than', '>=': 'at least',
  '&&': 'logical AND', '||': 'logical OR',
};

const TRUTH: Record<string, (x: number, y: number) => number> = {
  '&': (x, y) => x & y,
  '|': (x, y) => x | y,
  '^': (x, y) => x ^ y,
};

const RULE: Record<string, string> = {
  '&': 'AND gives 1 only where <b>both</b> bits are 1. AND with a mask <b>keeps</b> the mask bits and <b>clears</b> the rest — that\'s how <code>&amp;= ~mask</code> clears.',
  '|': 'OR gives 1 where <b>either</b> bit is 1. It can only add 1s, never remove them — that\'s why <code>|=</code> sets bits safely.',
  '^': 'XOR gives 1 where the bits <b>differ</b>. XOR with a mask <b>flips</b> exactly the mask bits.',
};

function el(tag: string, cls?: string, html?: string) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
}
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const bitLen = (v: number) => (v >>> 0 === 0 ? 1 : 32 - Math.clz32(v >>> 0));
const isNeg = (x: Val) => !x.u && (x.v | 0) < 0;

// Show 8, 16 or 32 bits: enough for every value in the step, no more.
function widthFor(...vals: Val[]) {
  if (vals.some(isNeg)) return 32;
  const need = Math.max(...vals.map((x) => bitLen(x.v)));
  return need <= 8 ? 8 : need <= 16 ? 16 : 32;
}

const CELL: Record<number, number> = { 8: 30, 16: 24, 32: 17 };
const GAP = 3;

function fmtHex(v: number, width: number) {
  return '0x' + (v >>> 0).toString(16).toUpperCase().padStart(width / 4, '0');
}
function fmtDec(x: Val) {
  return isNeg(x) ? String(x.v | 0) : String(x.v >>> 0);
}

function originText(o: Operand): string {
  switch (o.from) {
    case 'literal':
      if (/^0[xX]/.test(o.text)) return 'hex literal — each hex digit is 4 bits';
      if (/^0[bB]/.test(o.text)) return 'binary literal';
      return 'decimal literal';
    case 'macro': return 'ch32fun macro';
    case 'reg': return 'read from the register';
    case 'var': return 'variable';
    case 'step': return o.step === undefined ? 'sub-expression' : `result of step ${o.step + 1}`;
  }
}

interface Row {
  row: HTMLElement;
  cells: HTMLElement[]; // cells[bit]
  val: HTMLElement;
}

// One labelled row of bit cells.
function bitRow(label: string | HTMLElement, sub: string, x: Val | null, width: number, cls = ''): Row {
  const row = el('div', 'xrow ' + cls);
  const lab = el('div', 'xlabel');
  if (typeof label === 'string') lab.append(el('code', '', esc(label)));
  else lab.append(label);
  if (sub) lab.append(el('small', '', sub));
  const bits = el('div', 'xbits');
  const cells: HTMLElement[] = [];
  for (let b = width - 1; b >= 0; b--) {
    const c = el('div', 'xbit');
    c.dataset.b = String(b);
    if (x) {
      const on = (x.v >>> b) & 1;
      c.textContent = String(on);
      if (on) c.classList.add('one');
    } else c.classList.add('pending');
    if (b % 4 === 3 && b !== width - 1) c.classList.add('nib-start');
    cells[b] = c;
    bits.append(c);
  }
  const val = el('div', 'xval');
  if (x) val.innerHTML = `<code>${fmtHex(x.v, width)}</code><small>= ${fmtDec(x)}${x.u ? ' · unsigned' : ' · int'}</small>`;
  row.append(lab, bits, val);
  return { row, cells, val };
}

function setCell(c: HTMLElement, on: number) {
  c.classList.remove('pending');
  c.textContent = String(on);
  c.classList.toggle('one', !!on);
  c.classList.remove('pop');
  void c.offsetWidth; // restart the pop animation
  c.classList.add('pop');
}

function indexRow(width: number) {
  const row = el('div', 'xrow xidx');
  row.append(el('div', 'xlabel'));
  const bits = el('div', 'xbits');
  for (let b = width - 1; b >= 0; b--) {
    const c = el('div', 'xbit', String(b));
    if (b % 4 === 3 && b !== width - 1) c.classList.add('nib-start');
    bits.append(c);
  }
  row.append(bits, el('div', 'xval'));
  return row;
}

function operandLabel(o: Operand): HTMLElement {
  const wrap = el('span', 'xop-label');
  wrap.append(el('code', '', esc(o.text)));
  return wrap;
}

function rowFor(o: Operand, width: number, onJump: (i: number) => void, cls = '') {
  const r = bitRow(operandLabel(o), originText(o), o.val, width, cls);
  if (o.from === 'step' && o.step !== undefined) {
    const small = r.row.querySelector('.xlabel small')!;
    const a = el('button', 'xjump', small.textContent!);
    a.addEventListener('click', () => onJump(o.step!));
    small.replaceWith(a);
  }
  return r;
}

function notesEl(notes: Note[]) {
  if (!notes.length) return null;
  const ul = el('ul', 'notes');
  for (const n of notes) ul.append(el('li', 'note-' + n.level, esc(n.msg)));
  return ul;
}

interface Card {
  el: HTMLElement;
  play: (wait: (ms: number) => Promise<void>) => Promise<void>;
  final: () => void;
}

// ───────────── card builders

function shiftCard(s: Extract<Step, { k: 'binary' }>, jump: (i: number) => void): Card {
  const left = s.op === '<<';
  const n = s.b.val.u ? s.b.val.v : s.b.val.v | 0;
  const arith = !left && !s.a.val.u && (s.a.val.v | 0) < 0;
  const W = left ? widthFor(s.a.val, s.r) : widthFor(s.a.val);
  const pitch = CELL[W] + GAP;
  const card = el('div', 'xcard no-nib');
  card.style.setProperty('--xc', CELL[W] + 'px');
  card.style.setProperty('--xg', GAP + 'px');

  // Bits that end up outside the W-bit window.
  const a = s.a.val.v >>> 0;
  const lost = n === 0 ? 0 : n >= W ? a : left ? (a >>> (W - n)) & (2 ** n - 1) : a & (2 ** n - 1);

  const caption = left
    ? `Every bit moves <b>${n}</b> place${n === 1 ? '' : 's'} to the left. Zeros come in on the right; bits pushed past bit ${W - 1} are gone.${lost === 0 && n > 0 ? ` Nothing fell off, so this is the same as × 2<sup>${n}</sup> = × ${2 ** n}.` : ''}`
    : arith
      ? `Every bit moves <b>${n}</b> place${n === 1 ? '' : 's'} right. This is a <b>negative int</b>, so GCC copies the sign bit in on the left (arithmetic shift).`
      : `Every bit moves <b>${n}</b> place${n === 1 ? '' : 's'} right. Zeros come in on the left; the lowest ${n} bit${n === 1 ? '' : 's'} fall off. Same as ÷ ${2 ** n}, rounded down.`;

  // The shift amount is a count, not a bit pattern — show it small, in binary too.
  const countBits = Math.max(3, bitLen(n));
  const countEl = el('div', 'xcount');
  countEl.innerHTML = `<span>shift amount ${s.b.text === String(n) ? '' : `<code>${esc(s.b.text)}</code> `}= <b>${n}</b> =</span><span class="xmini">${Array.from({ length: countBits }, (_, i) => {
    const bit = (n >>> (countBits - 1 - i)) & 1;
    return `<i class="${bit ? 'one' : ''}">${bit}</i>`;
  }).join('')}</span><small>${s.b.from === 'step' ? originText(s.b) : 'a count, not a mask'}</small>`;

  const grid = el('div', 'xgrid');
  grid.append(indexRow(W));
  grid.append(rowFor(s.a, W, jump).row);

  // Sliding strip: the viewport shows W cells; the strip carries n extra fill cells.
  const res = el('div', 'xrow xresult');
  const lab = el('div', 'xlabel');
  const counter = el('small', '', '');
  lab.append(el('code', '', esc(s.text)), counter);
  const viewport = el('div', 'xbits xviewport');
  viewport.style.width = `${W * CELL[W] + (W - 1) * GAP}px`;
  const strip = el('div', 'xstrip');
  const fill = arith ? 1 : 0;
  const bits: number[] = []; // left to right
  const addFill = () => {
    for (let i = 0; i < n; i++) bits.push(fill);
  };
  if (!left) addFill();
  for (let b = W - 1; b >= 0; b--) bits.push((s.a.val.v >>> b) & 1);
  if (left) addFill();
  bits.forEach((on, i) => {
    const c = el('div', 'xbit' + (on ? ' one' : ''), String(on));
    const isFill = left ? i >= W : i < n;
    if (isFill) c.classList.add('fill');
    strip.append(c);
  });
  viewport.append(strip);
  const val = el('div', 'xval');
  res.append(lab, viewport, val);
  grid.append(res);

  const lostEl = el('div', 'xlost');
  const setPos = (i: number) => {
    const off = left ? -i * pitch : -(n - i) * pitch;
    strip.style.transform = `translateX(${off}px)`;
  };
  const showVal = () => {
    val.innerHTML = `<code>${fmtHex(s.r.v, W)}</code><small>= ${fmtDec(s.r)}</small>`;
    counter.textContent = 'result';
    if (lost) {
      const k = (lost >>> 0).toString(2).split('').filter((c) => c === '1').length;
      lostEl.innerHTML = `⚠ ${k} one-bit${k === 1 ? '' : 's'} fell off the ${left ? 'left' : 'right'} end and ${k === 1 ? 'is' : 'are'} lost.`;
    }
  };

  card.append(el('p', 'xcaption', caption), countEl, grid, lostEl);
  const ns = notesEl(s.notes);
  if (ns) card.append(ns);

  return {
    el: card,
    final() {
      strip.classList.remove('animating');
      setPos(n);
      showVal();
    },
    async play(wait) {
      strip.classList.remove('animating');
      setPos(0);
      val.innerHTML = '';
      lostEl.innerHTML = '';
      counter.textContent = n === 0 ? 'shift by 0 — nothing moves' : `shifted 0 of ${n}`;
      await wait(500);
      strip.classList.add('animating');
      const per = n <= 8 ? 380 : n <= 16 ? 200 : 110;
      for (let i = 1; i <= n; i++) {
        setPos(i);
        counter.textContent = `shifted ${i} of ${n}`;
        await wait(per);
      }
      await wait(200);
      showVal();
    },
  };
}

function bitwiseCard(s: Extract<Step, { k: 'binary' }>, jump: (i: number) => void): Card {
  const W = widthFor(s.a.val, s.b.val, s.r);
  const f = TRUTH[s.op];
  const card = el('div', 'xcard');
  card.style.setProperty('--xc', CELL[W] + 'px');
  card.style.setProperty('--xg', GAP + 'px');
  const grid = el('div', 'xgrid');
  const a = rowFor(s.a, W, jump);
  const opRow = el('div', 'xoprow', `<span>${esc(s.op)}</span>`);
  const b = rowFor(s.b, W, jump);
  const r = bitRow(s.text, '', null, W, 'xresult');
  grid.append(indexRow(W), a.row, opRow, b.row, r.row);

  const table = el('table', 'xtruth');
  table.innerHTML = `<tr><th colspan="3">${OP_NAME[s.op]}</th></tr>` + [
    [0, 0], [0, 1], [1, 0], [1, 1],
  ].map(([x, y]) => `<tr data-k="${x}${y}"><td>${x} ${esc(s.op)} ${y}</td><td>=</td><td class="${f(x, y) ? 'one' : ''}">${f(x, y)}</td></tr>`).join('');

  const body = el('div', 'xbody');
  body.append(grid, table);
  card.append(el('p', 'xcaption', RULE[s.op]), body);
  const ns = notesEl(s.notes);
  if (ns) card.append(ns);

  const clearCols = () => card.querySelectorAll('.col-on').forEach((c) => c.classList.remove('col-on'));
  const showVal = () => {
    r.val.innerHTML = `<code>${fmtHex(s.r.v, W)}</code><small>= ${fmtDec(s.r)}</small>`;
  };
  return {
    el: card,
    final() {
      clearCols();
      for (let bit = 0; bit < W; bit++) {
        r.cells[bit].classList.remove('pending');
        const on = (s.r.v >>> bit) & 1;
        r.cells[bit].textContent = String(on);
        r.cells[bit].classList.toggle('one', !!on);
      }
      showVal();
    },
    async play(wait) {
      r.val.innerHTML = '';
      for (let bit = 0; bit < W; bit++) {
        r.cells[bit].className = 'xbit pending' + (bit % 4 === 3 && bit !== W - 1 ? ' nib-start' : '');
        r.cells[bit].textContent = '';
      }
      await wait(400);
      const per = W === 8 ? 260 : W === 16 ? 150 : 80;
      for (let bit = 0; bit < W; bit++) {
        clearCols();
        const x = (s.a.val.v >>> bit) & 1;
        const y = (s.b.val.v >>> bit) & 1;
        for (const c of [a.cells[bit], b.cells[bit], r.cells[bit]]) c.classList.add('col-on');
        table.querySelector(`[data-k="${x}${y}"]`)!.classList.add('col-on');
        setCell(r.cells[bit], f(x, y));
        await wait(per);
      }
      clearCols();
      showVal();
    },
  };
}

function notCard(s: Extract<Step, { k: 'unary' }>, jump: (i: number) => void): Card {
  const W = widthFor(s.a.val, s.r);
  const card = el('div', 'xcard');
  card.style.setProperty('--xc', CELL[W] + 'px');
  card.style.setProperty('--xg', GAP + 'px');
  const grid = el('div', 'xgrid');
  const a = rowFor(s.a, W, jump);
  const r = bitRow(s.text, '', null, W, 'xresult');
  grid.append(indexRow(W), a.row, el('div', 'xoprow', '<span>~</span>'), r.row);
  const caption =
    `<code>~</code> flips <b>every</b> bit: 0 → 1, 1 → 0.` +
    (W === 32 && bitLen(s.a.val.v) <= 16 ? ` It flips all 32 bits of the int — that's why <code>~(0xF &lt;&lt; 4)</code> is <code>0xFFFFFF0F</code>, not <code>0x0F</code>.` : '');
  card.append(el('p', 'xcaption', caption), grid);
  const showVal = () => {
    r.val.innerHTML = `<code>${fmtHex(s.r.v, W)}</code><small>= ${fmtDec(s.r)}</small>`;
  };
  return {
    el: card,
    final() {
      for (let bit = 0; bit < W; bit++) {
        const on = (s.r.v >>> bit) & 1;
        r.cells[bit].classList.remove('pending', 'col-on');
        r.cells[bit].textContent = String(on);
        r.cells[bit].classList.toggle('one', !!on);
        a.cells[bit].classList.remove('col-on');
      }
      showVal();
    },
    async play(wait) {
      r.val.innerHTML = '';
      for (let bit = 0; bit < W; bit++) {
        r.cells[bit].className = 'xbit pending' + (bit % 4 === 3 && bit !== W - 1 ? ' nib-start' : '');
        r.cells[bit].textContent = '';
      }
      await wait(400);
      const per = W === 8 ? 200 : W === 16 ? 120 : 60;
      for (let bit = 0; bit < W; bit++) {
        a.cells[bit].classList.add('col-on');
        r.cells[bit].classList.add('col-on');
        setCell(r.cells[bit], (s.r.v >>> bit) & 1);
        await wait(per);
        a.cells[bit].classList.remove('col-on');
        r.cells[bit].classList.remove('col-on');
      }
      showVal();
    },
  };
}

// Rows revealed one after another; used for arithmetic, compare, cast, negate, write.
function revealCard(caption: string, rows: { row: HTMLElement; later?: boolean }[], width: number, extra: (HTMLElement | null)[] = []): Card {
  const card = el('div', 'xcard');
  card.style.setProperty('--xc', CELL[width] + 'px');
  card.style.setProperty('--xg', GAP + 'px');
  const grid = el('div', 'xgrid');
  grid.append(indexRow(width));
  for (const r of rows) grid.append(r.row);
  card.append(el('p', 'xcaption', caption), grid);
  for (const e of extra) if (e) card.append(e);
  const later = rows.filter((r) => r.later).map((r) => r.row);
  return {
    el: card,
    final() {
      later.forEach((r) => r.classList.remove('hidden-row'));
    },
    async play(wait) {
      later.forEach((r) => r.classList.add('hidden-row'));
      await wait(500);
      for (const r of later) {
        r.classList.remove('hidden-row');
        r.classList.add('row-in');
        await wait(700);
      }
    },
  };
}

function verdict(r: Val) {
  const e = el('p', 'xverdict ' + (r.v ? 'is-true' : 'is-false'), `→ <b>${r.v ? 'true' : 'false'}</b> (C gives <code>${r.v ? 1 : 0}</code>)`);
  return e;
}

function buildCard(s: Step, jump: (i: number) => void): Card {
  if (s.k === 'binary') {
    if (s.op === '<<' || s.op === '>>') return shiftCard(s, jump);
    if (TRUTH[s.op]) return bitwiseCard(s, jump);
    const W = widthFor(s.a.val, s.b.val, s.r);
    const cmp = ['==', '!=', '<', '<=', '>', '>='].includes(s.op);
    if (cmp) {
      const mixed = s.a.val.u !== s.b.val.u;
      const cap = `Compares the two values (${OP_NAME[s.op]}). The result is an <code>int</code>: 1 for true, 0 for false.` + (mixed ? ' One side is <b>unsigned</b>, so both are compared as unsigned — a negative int turns into a huge number.' : '');
      return revealCard(cap, [{ row: rowFor(s.a, W, jump).row }, { row: el('div', 'xoprow', `<span>${esc(s.op)}</span>`) }, { row: rowFor(s.b, W, jump).row }], W, [verdict(s.r), notesEl(s.notes)]);
    }
    const cap: Record<string, string> = {
      '+': 'Binary addition works like decimal: 1 + 1 = 10₂, carry the 1.',
      '-': 'Subtraction. In binary the CPU adds the two\'s complement: a − b = a + (~b + 1).',
      '*': 'Multiplication. Multiplying by 2ⁿ is the same as shifting left by n.',
      '/': 'Integer division — the fraction is thrown away. Dividing by 2ⁿ is like shifting right by n (for non-negative values).',
      '%': 'Remainder. x % 2ⁿ is the same as x & (2ⁿ − 1): the low n bits.',
    };
    return revealCard(cap[s.op] ?? OP_NAME[s.op], [{ row: rowFor(s.a, W, jump).row }, { row: el('div', 'xoprow', `<span>${esc(s.op)}</span>`) }, { row: rowFor(s.b, W, jump).row }, { row: bitRow(s.text, '', s.r, W, 'xresult').row, later: true }], W, [notesEl(s.notes)]);
  }
  if (s.k === 'unary') {
    if (s.op === '~') return notCard(s, jump);
    const W = widthFor(s.a.val, s.r);
    if (s.op === '-') {
      const inv = { v: ~s.a.val.v >>> 0, u: s.a.val.u };
      return revealCard(
        'Negation uses <b>two\'s complement</b>: −x = ~x + 1. That\'s why −1 is all ones.',
        [{ row: rowFor(s.a, 32, jump).row }, { row: bitRow('~x', 'flip every bit', inv, 32).row, later: true }, { row: bitRow(s.text, '… then add 1', s.r, 32, 'xresult').row, later: true }],
        32,
      );
    }
    if (s.op === '!') {
      return revealCard('<code>!</code> asks "is it zero?". Zero → 1, anything else → 0. It looks at the whole value, not single bits.', [{ row: rowFor(s.a, W, jump).row }, { row: bitRow(s.text, '', s.r, W, 'xresult').row, later: true }], W);
    }
    return revealCard('Unary plus does nothing.', [{ row: rowFor(s.a, W, jump).row }], W);
  }
  if (s.k === 'cast') {
    const W = widthFor(s.a.val, s.r);
    const keep: Record<string, string> = { uint8_t: 'the low 8 bits', int8_t: 'the low 8 bits (bit 7 becomes the sign)', uint16_t: 'the low 16 bits', int16_t: 'the low 16 bits (bit 15 becomes the sign)' };
    const cap = keep[s.type] ? `Casting to <code>${s.type}</code> keeps only ${keep[s.type]}.` : `Casting to <code>${s.type}</code> keeps all 32 bits and changes how they're read (${s.r.u ? 'unsigned' : 'signed'}).`;
    return revealCard(cap, [{ row: rowFor(s.a, W, jump).row }, { row: bitRow(s.text, '', s.r, W, 'xresult').row, later: true }], W);
  }
  if (s.k === 'logic') {
    const W = widthFor(s.a.val, s.b?.val ?? s.a.val);
    const aTrue = s.a.val.v !== 0;
    const cap = s.b
      ? `<code>${s.op}</code> first checks the left side (${aTrue ? 'non-zero → true' : 'zero → false'}), then has to look at the right side.`
      : `<code>${s.op}</code> checks the left side: ${aTrue ? 'non-zero → true' : 'zero → false'}. That already decides it, so the right side <b>never runs</b> (short-circuit).`;
    const rows = [{ row: rowFor(s.a, W, jump).row }];
    if (s.b) rows.push({ row: rowFor(s.b, W, jump).row });
    return revealCard(cap, rows, W, [verdict(s.r)]);
  }
  if (s.k === 'cond') {
    const W = widthFor(s.test.val, s.r);
    return revealCard(`<code>?:</code> picks a branch: the test is ${s.test.val.v ? 'non-zero, so the first' : 'zero, so the second'} one.`, [{ row: rowFor(s.test, W, jump).row }, { row: rowFor(s.chosen, W, jump, 'xresult').row, later: true }], W);
  }
  if (s.k === 'value') {
    const W = widthFor(s.a.val);
    const r = rowFor(s.a, W, jump, 'xresult');
    const hex = el('div', 'xhexmap');
    for (let n = W / 4 - 1; n >= 0; n--) {
      const nib = (s.a.val.v >>> (n * 4)) & 0xf;
      hex.append(el('span', '', `${nib.toString(2).padStart(4, '0')} = <b>${nib.toString(16).toUpperCase()}</b>`));
    }
    return revealCard(`Just a value — here is how it looks in binary. Each group of 4 bits is one hex digit.`, [{ row: r.row }], W, [hex]);
  }
  // write
  const W = widthFor(s.value.val, { v: s.stored, u: true });
  const stored = { v: s.stored, u: s.value.val.u };
  const cap = s.op === '=' ? `The value is stored into <code>${esc(s.target)}</code>.` : `<code>${esc(s.target)} ${esc(s.op)} x</code> is short for <code>${esc(s.target)} = ${esc(s.target)} ${esc(s.op.slice(0, -1))} x</code> — step ${(s.value.step ?? 0) + 1} computed that. Now it gets stored.`;
  const extra = [s.effect ? el('p', 'xeffect', `Side effect: <code>${esc(s.effect)}</code>`) : null, notesEl(s.notes)];
  return revealCard(cap, [{ row: rowFor(s.value, W, jump).row }, { row: bitRow(s.target, 'now holds', stored, W, 'xresult').row, later: true }], W, extra);
}

// ───────────── the stepper

export function renderExplain(steps: Step[], opts: { autoplay?: boolean } = {}): HTMLElement & { playAll?: () => void } {
  const root = el('div', 'explain') as HTMLElement & { playAll?: () => void };
  if (!steps.length) {
    root.append(el('p', 'muted', 'Nothing to step through.'));
    return root;
  }
  let idx = 0;
  let token = 0;
  let speed = 1;
  let card: Card | null = null;

  const chips = el('div', 'xchips');
  const stage = el('div', 'xstage');
  const bar = el('div', 'xcontrols');
  const prev = el('button', 'btn btn-small btn-ghost', '← Prev');
  const replay = el('button', 'btn btn-small', '▶ Play step');
  const all = el('button', 'btn btn-small btn-run', '▶▶ Play all');
  const next = el('button', 'btn btn-small btn-ghost', 'Next →');
  const spd = el('button', 'btn btn-small btn-ghost', 'Speed 1×');
  spd.title = 'Animation speed';
  bar.append(prev, replay, all, next, spd);

  steps.forEach((s, i) => {
    const c = el('button', 'xchip');
    c.innerHTML = `<b>${i + 1}</b><code>${esc(s.text)}</code>`;
    if (s.k === 'write') c.classList.add('xchip-write');
    c.title = s.text;
    c.addEventListener('click', () => show(i, true));
    chips.append(c);
  });

  const wait = (tok: number) => (ms: number) =>
    new Promise<void>((res, rej) =>
      setTimeout(() => (tok === token ? res() : rej(CANCEL)), ms / speed),
    );

  function header(s: Step, i: number) {
    const h = el('div', 'xhead');
    const title = s.k === 'write' ? `${s.target} ${s.op} …` : s.text;
    const opName = s.k === 'binary' || s.k === 'unary' || s.k === 'logic' ? OP_NAME[s.op] : s.k === 'write' ? 'store' : s.k;
    h.innerHTML = `<span class="xstep">Step ${i + 1} of ${steps.length}</span><code class="xexpr">${esc(title)}</code><span class="xopname">${esc(opName ?? '')}</span>`;
    return h;
  }

  // Resolves true if the step finished, false if something else interrupted it.
  async function show(i: number, animate: boolean): Promise<boolean> {
    idx = Math.max(0, Math.min(steps.length - 1, i));
    const tok = ++token;
    chips.querySelectorAll('.xchip').forEach((c, k) => c.classList.toggle('on', k === idx));
    card = buildCard(steps[idx], (j) => show(j, true));
    stage.replaceChildren(header(steps[idx], idx), card.el);
    prev.toggleAttribute('disabled', idx === 0);
    next.toggleAttribute('disabled', idx === steps.length - 1);
    if (!animate) {
      card.final();
      return true;
    }
    try {
      await card.play(wait(tok));
      return true;
    } catch (e) {
      if (e !== CANCEL) throw e;
      return false;
    }
  }

  async function playAll() {
    for (let i = 0; i < steps.length; i++) {
      if (!(await show(i, true))) return;
      try {
        await wait(token)(i === steps.length - 1 ? 0 : 900);
      } catch {
        return; // user took over
      }
    }
  }

  prev.addEventListener('click', () => show(idx - 1, true));
  next.addEventListener('click', () => show(idx + 1, true));
  replay.addEventListener('click', () => show(idx, true));
  all.addEventListener('click', playAll);
  spd.addEventListener('click', () => {
    speed = speed === 1 ? 0.5 : speed === 0.5 ? 2 : 1;
    spd.textContent = `Speed ${speed === 0.5 ? '½' : speed}×`;
  });

  root.append(chips, stage, bar);
  root.playAll = playAll;
  if (opts.autoplay) playAll();
  else show(steps.length - 1, false);
  return root;
}
