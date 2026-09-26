// "What you need" panel: a bit-level picture of the level's target, derived from its checks.

import { REG_BY_KEY } from '../core/chip';
import type { BitGoal, LevelGoal, TargetGoal } from '../core/goal';
import { decodePin } from './regview';

function el(tag: string, cls?: string, html?: string) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
}
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const name = (key: string) => key.replace(/^var:/, '');

const LEGEND: Record<string, [string, string]> = {
  set: ['1', 'must be 1'],
  clear: ['0', 'must be 0'],
  flip: ['⇄', 'flip it'],
  keep: ['·', 'keep as it was'],
  any: ['?', "don't care"],
  copy: ['n', 'copy of bit n of the source'],
  test: ['◆', 'decides the answer'],
};

// Custom checks are phrased as failures ("The LED is not lit"); say them as requirements.
const EXTRA_TEXT: Record<string, string> = {
  'LED on': 'The LED on PC1 must light up — PC1 must be a push-pull output driving high.',
  'uses BSHR': 'Do it with a single write to <code>GPIOC-&gt;BSHR</code> — no read-modify-write of <code>OUTDR</code>.',
};

// "4–7", "1, 6", "3"
function ranges(bits: number[]): string {
  const s = [...bits].sort((a, b) => a - b);
  const out: string[] = [];
  for (let i = 0; i < s.length; ) {
    let j = i;
    while (j + 1 < s.length && s[j + 1] === s[j] + 1) j++;
    out.push(j > i + 1 ? `${s[i]}–${s[j]}` : j === i + 1 ? `${s[i]}, ${s[j]}` : `${s[i]}`);
    i = j + 1;
  }
  return out.join(', ');
}

function bitWord(key: string, bits: number[]): string {
  const def = REG_BY_KEY.get(key);
  const label = (b: number) => {
    if (!def) return '';
    if (def.periph.startsWith('GPIO') && def.name !== 'CFGLR') {
      if (def.name === 'BSHR') return b >= 16 ? `reset P${def.periph[4]}${b - 16}` : `set P${def.periph[4]}${b}`;
      return `P${def.periph[4]}${b}`;
    }
    return def.fields.find((f) => f.width === 1 && f.lsb === b)?.name ?? '';
  };
  const base = `bit${bits.length > 1 ? 's' : ''} ${ranges(bits)}`;
  const labels = bits.map(label).filter(Boolean);
  return labels.length && labels.length <= 3 ? `${base} (${labels.join(', ')})` : base;
}

function sentence(t: TargetGoal): string {
  const by = (k: BitGoal['k']) => t.bits.map((b, i) => (b.k === k ? i : -1)).filter((i) => i >= 0);
  const parts: string[] = [];
  const def = REG_BY_KEY.get(t.key);
  const handled = new Set<number>();

  // CFGLR: describe whole pin slots when all four bits are pinned down.
  if (def?.name === 'CFGLR') {
    for (let p = 0; p < 8; p++) {
      const nib = t.bits.slice(p * 4, p * 4 + 4);
      if (nib.every((b) => b.k === 'set' || b.k === 'clear')) {
        const v = nib.reduce((acc, b, i) => acc | ((b.k === 'set' ? 1 : 0) << i), 0);
        parts.push(`set the <b>P${def.periph[4]}${p}</b> slot (bits ${p * 4 + 3}–${p * 4}) to <code>${v.toString(2).padStart(4, '0')}</code> = ${decodePin(v)}`);
        for (let i = 0; i < 4; i++) handled.add(p * 4 + i);
      }
    }
  }
  const rest = (xs: number[]) => xs.filter((i) => !handled.has(i));
  const set = rest(by('set'));
  const clear = rest(by('clear'));
  const flip = by('flip');
  const any = by('any');
  if (set.length) parts.push(`set ${bitWord(t.key, set)} to <b>1</b>`);
  if (clear.length) parts.push(`clear ${bitWord(t.key, clear)} to <b>0</b>`);
  if (flip.length) parts.push(`<b>flip</b> ${bitWord(t.key, flip)}`);

  // Copies: group runs with the same source and a constant offset.
  const copies = t.bits.map((b, i) => ({ b, i })).filter((x) => x.b.k === 'copy') as { b: Extract<BitGoal, { k: 'copy' }>; i: number }[];
  const groups = new Map<string, number[]>();
  for (const c of copies) {
    const g = `${c.b.from}|${c.b.bit - c.i}|${c.b.invert}`;
    groups.set(g, [...(groups.get(g) ?? []), c.i]);
  }
  for (const [g, dst] of groups) {
    const [from, off, inv] = g.split('|');
    const src = dst.map((i) => i + Number(off));
    parts.push(`put ${inv === 'true' ? 'the inverse of ' : ''}<code>${esc(name(from))}</code> bits ${ranges(src)} into bits ${ranges(dst)}`);
  }
  if (any.length) parts.push(`bits ${ranges(any)} can be anything`);
  const keep = by('keep').length;
  if (keep === 32) return 'Must not change — all 32 bits stay exactly as they were.';
  let text = parts.join('; ');
  if (keep) text += `${text ? '; ' : ''}keep the other ${keep} bit${keep > 1 ? 's' : ''} exactly as they were`;
  // Capitalise the first letter even when the text starts with a tag like <b>.
  return text.replace(/^((?:<[^>]+>)*)([a-z])/, (_, tags: string, c: string) => tags + c.toUpperCase()) + '.';
}

function cellFor(b: BitGoal | 'test' | 'ignore', i: number): HTMLElement {
  const k = typeof b === 'string' ? b : b.k;
  const c = el('div', `gbit g-${k}`);
  if (typeof b !== 'string' && b.k === 'copy') {
    c.innerHTML = `<span>${b.invert ? '¬' : ''}${b.bit}</span>`;
    c.title = `bit ${i}: copy of ${name(b.from)} bit ${b.bit}${b.invert ? ', inverted' : ''}`;
  } else {
    c.textContent = k === 'ignore' ? '' : LEGEND[k]?.[0] ?? '';
    c.title = `bit ${i}: ${k === 'ignore' ? 'ignored' : LEGEND[k]?.[1]}`;
  }
  if (i % 4 === 3 && i !== 31) c.classList.add('nib-start');
  return c;
}

function strip(width: number, cell: (i: number) => HTMLElement, under?: (p: number) => string | null) {
  const wrap = el('div', 'gstrip-scroll');
  const idx = el('div', 'gstrip gidx');
  const row = el('div', 'gstrip');
  for (let i = width - 1; i >= 0; i--) {
    const n = el('div', 'gbit', String(i));
    if (i % 4 === 3 && i !== width - 1) n.classList.add('nib-start');
    idx.append(n);
    const c = cell(i);
    if (i === width - 1) c.classList.remove('nib-start');
    row.append(c);
  }
  wrap.append(idx, row);
  if (under) {
    const u = el('div', 'gstrip gunder');
    for (let p = width / 4 - 1; p >= 0; p--) {
      const t = under(p);
      const s = el('div', 'gnib' + (t ? '' : ' empty'), t ?? '');
      if (p !== width / 4 - 1) s.classList.add('nib-start');
      u.append(s);
    }
    wrap.append(u);
  }
  return wrap;
}

function targetBlock(t: TargetGoal): HTMLElement {
  const box = el('div', 'gtarget');
  box.append(el('div', 'ghead', `<code>${esc(name(t.key))}</code>`), el('p', 'gsentence', sentence(t)));
  const def = REG_BY_KEY.get(t.key);
  const under =
    def?.name === 'CFGLR'
      ? (p: number) => {
          const nib = t.bits.slice(p * 4, p * 4 + 4);
          const pin = `P${def.periph[4]}${p}`;
          if (nib.every((b) => b.k === 'set' || b.k === 'clear')) {
            const v = nib.reduce((acc, b, i) => acc | ((b.k === 'set' ? 1 : 0) << i), 0);
            return `<b>${pin}</b> ${decodePin(v)}`;
          }
          if (nib.every((b) => b.k === 'any')) return `<b>${pin}</b> any`;
          return `<b>${pin}</b> keep`;
        }
      : undefined;
  box.append(strip(32, (i) => cellFor(t.bits[i], i), under));
  return box;
}

export function renderGoal(g: LevelGoal): HTMLElement | null {
  if (!g.targets.length && g.exprValue === undefined && !g.truthy && !g.extras.length) return null;
  const panel = el('section', 'goal-panel');
  panel.append(el('div', 'editor-label', 'What you need'));
  const used = new Set<string>();

  if (g.exprValue !== undefined) {
    const v = g.exprValue >>> 0;
    const width = v <= 0xff ? 8 : v <= 0xffff ? 16 : 32;
    const box = el('div', 'gtarget');
    box.append(el('p', 'gsentence', `Your expression must come out as exactly <code>0x${v.toString(16).toUpperCase()}</code> (= ${v})${width < 32 ? ` — all higher bits 0` : ''}:`));
    box.append(
      strip(width, (i) => {
        const on = (v >>> i) & 1;
        used.add(on ? 'set' : 'clear');
        return cellFor({ k: on ? 'set' : 'clear' }, i);
      }),
    );
    panel.append(box);
  }

  if (g.truthy) {
    const { key, bit, invert } = g.truthy;
    used.add('test');
    const box = el('div', 'gtarget');
    box.append(
      el('div', 'ghead', `<code>${esc(name(key))}</code>`),
      el('p', 'gsentence', `Make the expression <b>true</b> (non-zero) exactly when ${bitWord(key, [bit])} of <code>${esc(name(key))}</code> is <b>${invert ? 0 : 1}</b>, and false (0) otherwise. Every other bit must be ignored.`),
      strip(32, (i) => cellFor(i === bit ? 'test' : 'ignore', i)),
    );
    panel.append(box);
  }

  for (const t of g.targets) {
    t.bits.forEach((b) => used.add(b.k));
    panel.append(targetBlock(t));
  }

  if (g.extras.length) {
    const ul = el('ul', 'gextras');
    for (const e of g.extras) ul.append(el('li', '', EXTRA_TEXT[e.label] ?? esc(e.why)));
    panel.append(el('div', 'gextras-title', 'Also required'), ul);
  }

  const legend = el('div', 'glegend');
  for (const k of Object.keys(LEGEND)) {
    if (!used.has(k)) continue;
    const item = el('span');
    item.append(cellFor(k === 'copy' ? { k: 'copy', from: '', bit: 0, invert: false } : (k as 'test'), 0), document.createTextNode(LEGEND[k][1]));
    item.querySelector('.gbit')!.classList.remove('nib-start');
    if (k === 'copy') item.querySelector('.gbit')!.innerHTML = '<span>n</span>';
    legend.append(item);
  }
  if (legend.children.length) panel.append(legend);
  return panel;
}
