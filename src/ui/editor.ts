// Textarea with a syntax-highlighted <pre> behind it. No dependencies.

import { MACROS, PERIPHS } from '../core/chip';

const KEYWORDS = new Set(['if', 'else', 'int', 'unsigned', 'signed', 'uint8_t', 'uint16_t', 'uint32_t', 'int8_t', 'int16_t', 'int32_t', 'volatile', 'const']);
const TOKEN = /(\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$))|(0[xX][0-9a-fA-F]+[uUlL]*|0[bB][01]+[uUlL]*|\d+[uUlL]*)|([A-Za-z_]\w*)|(->)|(<<=?|>>=?|[|&^~!=<>+\-*/%]=?|&&|\|\|)|([(){};,?:])|(\s+)|([\s\S])/g;

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function highlight(src: string, errPos: number | null = null): string {
  let html = '';
  let prevArrow = false;
  let marked = false;
  for (const m of src.matchAll(TOKEN)) {
    const [text, comment, num, ident, arrow, op, punct] = m;
    let cls = '';
    if (comment) cls = 'tk-com';
    else if (num) cls = 'tk-num';
    else if (ident) {
      if (prevArrow) cls = 'tk-reg';
      else if (KEYWORDS.has(ident)) cls = 'tk-kw';
      else if (MACROS[ident]) cls = 'tk-mac';
      else if (PERIPHS.has(ident)) cls = 'tk-per';
      else if (/^Delay_(Ms|Us)$/.test(ident)) cls = 'tk-fn';
      else cls = 'tk-var';
    } else if (arrow || op) cls = 'tk-op';
    else if (punct) cls = 'tk-pun';
    if (!/^\s+$/.test(text)) prevArrow = !!arrow;

    const start = m.index!;
    const hit = errPos !== null && !marked && errPos >= start && errPos < start + text.length && !/^\s+$/.test(text);
    let body = esc(text);
    if (cls) body = `<span class="${cls}">${body}</span>`;
    if (hit) {
      body = `<span class="tk-err">${body}</span>`;
      marked = true;
    }
    html += body;
  }
  if (errPos !== null && !marked) html += '<span class="tk-err"> </span>';
  // Trailing newline keeps the pre as tall as the textarea.
  return html + '\n';
}

export interface Editor {
  el: HTMLElement;
  get(): string;
  set(v: string): void;
  setError(pos: number | null): void;
  focus(): void;
}

export function createEditor(opts: { onChange: (v: string) => void; onRun: () => void; placeholder?: string; rows?: number }): Editor {
  const wrap = document.createElement('div');
  wrap.className = 'editor';
  const pre = document.createElement('pre');
  pre.setAttribute('aria-hidden', 'true');
  const ta = document.createElement('textarea');
  ta.spellcheck = false;
  ta.autocapitalize = 'off';
  ta.setAttribute('autocomplete', 'off');
  ta.setAttribute('autocorrect', 'off');
  ta.setAttribute('aria-label', 'C code');
  ta.rows = opts.rows ?? 6;
  if (opts.placeholder) ta.placeholder = opts.placeholder;
  wrap.append(pre, ta);

  let err: number | null = null;
  const paint = () => {
    pre.innerHTML = highlight(ta.value, err);
    pre.scrollTop = ta.scrollTop;
    pre.scrollLeft = ta.scrollLeft;
  };

  ta.addEventListener('input', () => {
    err = null;
    paint();
    opts.onChange(ta.value);
  });
  ta.addEventListener('scroll', () => {
    pre.scrollTop = ta.scrollTop;
    pre.scrollLeft = ta.scrollLeft;
  });
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      opts.onRun();
    } else if (e.key === 'Escape') {
      ta.blur(); // lets the page-level [ / ] shortcuts work
    } else if (e.key === 'Tab' && !e.shiftKey) {
      e.preventDefault();
      ta.setRangeText('    ', ta.selectionStart, ta.selectionEnd, 'end');
      ta.dispatchEvent(new Event('input'));
    }
  });

  paint();
  return {
    el: wrap,
    get: () => ta.value,
    set(v) {
      ta.value = v;
      err = null;
      paint();
    },
    setError(pos) {
      err = pos;
      paint();
    },
    focus: () => ta.focus(),
  };
}

export function lineCol(src: string, pos: number) {
  const before = src.slice(0, pos).split('\n');
  return { line: before.length, col: before[before.length - 1].length + 1 };
}
