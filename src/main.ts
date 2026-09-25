import './style.css';
import { Chip, ChipState, REGS, cloneState, resetState, snapshot } from './core/chip';
import { Var, runExpression, runProgram } from './core/interp';
import { CHAPTERS, LEVELS, Level } from './core/levels';
import { CaseResult, buildState, rng, runLevel } from './core/runner';
import { renderBoard } from './ui/board';
import { CHEATSHEET } from './ui/cheatsheet';
import { Editor, createEditor, lineCol } from './ui/editor';
import { renderRegister } from './ui/regview';

// ───────────── storage (every access guarded: private windows / blocked storage)
const store = {
  get<T>(k: string, fallback: T): T {
    try {
      const v = localStorage.getItem('bitdojo.' + k);
      return v === null ? fallback : (JSON.parse(v) as T);
    } catch {
      return fallback;
    }
  },
  set(k: string, v: unknown) {
    try {
      localStorage.setItem('bitdojo.' + k, JSON.stringify(v));
    } catch {
      /* ignore */
    }
  },
};

const solved = new Set<string>(store.get<string[]>('solved', []));
const peeked = new Set<string>(store.get<string[]>('peeked', []));
const saveProgress = () => {
  store.set('solved', [...solved]);
  store.set('peeked', [...peeked]);
};

// ───────────── helpers
const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector<T>(sel)!;
function h(tag: string, attrs: Record<string, string> = {}, ...kids: (Node | string | null | undefined | false)[]) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'html') e.innerHTML = v;
    else e.setAttribute(k, v);
  }
  for (const c of kids) if (c) e.append(c);
  return e;
}
const app = $('#app');

// ───────────── theme + cheat sheet
const applyTheme = (t: string | null) => {
  if (t) document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
};
applyTheme(store.get<string | null>('theme', null));
$('#theme').addEventListener('click', () => {
  const cur = document.documentElement.dataset.theme ?? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  const next = cur === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  store.set('theme', next);
});
const dialog = $<HTMLDialogElement>('#cheatsheet');
$('#cheatsheet-body').innerHTML = CHEATSHEET;
$('#cheat').addEventListener('click', () => dialog.showModal());
$('#cheatsheet-close').addEventListener('click', () => dialog.close());
dialog.addEventListener('click', (e) => e.target === dialog && dialog.close());

// ───────────── routing
function route() {
  const m = location.hash.match(/^#\/(level|sandbox)\/?([\w-]*)/);
  document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('active', a.getAttribute('data-nav') === (m?.[1] === 'sandbox' ? 'sandbox' : 'levels')));
  if (m?.[1] === 'sandbox') return showSandbox();
  const lvl = LEVELS.find((l) => l.id === m?.[2]) ?? LEVELS.find((l) => !solved.has(l.id)) ?? LEVELS[0];
  showLevel(lvl);
}
window.addEventListener('hashchange', route);

// ───────────── level view
function sidebar(current?: Level) {
  const aside = h('details', { class: 'side', ...(matchMedia('(min-width: 1000px)').matches ? { open: '' } : {}) });
  const count = LEVELS.filter((l) => solved.has(l.id)).length;
  aside.append(
    h('summary', {}, h('span', {}, 'Levels'), h('span', { class: 'side-count' }, `${count}/${LEVELS.length}`)),
    h('div', { class: 'progress', style: `--p:${count / LEVELS.length}` }),
  );
  let n = 0;
  CHAPTERS.forEach((ch, ci) => {
    const list = h('ol', { start: String(n + 1) });
    for (const l of LEVELS.filter((l) => l.chapter === ch)) {
      n++;
      const state = solved.has(l.id) ? (peeked.has(l.id) ? 'peeked' : 'solved') : '';
      list.append(h('li', { class: state }, h('a', { href: `#/level/${l.id}`, ...(l === current ? { 'aria-current': 'page' } : {}) }, h('span', { class: 'lv-dot' }), l.title)));
    }
    aside.append(h('div', { class: 'chapter' }, h('h3', {}, h('span', { class: 'ch-num' }, String(ci + 1)), ch), list));
  });
  return aside;
}

function previewCases(level: Level): CaseResult[] {
  return level.cases(rng(level.seed)).map((c) => {
    const state = buildState(c);
    const chip = new Chip(state);
    const beforeVars: Record<string, number> = {};
    for (const name of Object.keys(level.vars ?? {})) beforeVars[name] = c.vars?.[name] ?? 0;
    return { label: c.label, before: snapshot(chip), beforeVars, beforeState: cloneState(state), pass: false, problems: [], notes: [] };
  });
}

function showLevel(level: Level) {
  const idx = LEVELS.indexOf(level);
  let results: CaseResult[] | null = null;
  let selected = 0;
  let hintsShown = 0;
  let showSolution = false;

  const editor: Editor = createEditor({
    onChange: (v) => store.set('code.' + level.id, v),
    onRun: run,
    rows: level.kind === 'expr' ? 2 : 6,
    placeholder: level.kind === 'expr' ? 'type one C expression, e.g. 1 << 3' : 'C statements, e.g. reg |= (1 << 3);',
  });
  editor.set(store.get('code.' + level.id, level.starter));

  const resultCol = h('section', { class: 'col-result', 'aria-live': 'polite' });
  const errBox = h('div', { class: 'code-error', hidden: '' });
  const hintBox = h('div', { class: 'hints' });
  const hintBtn = h('button', { class: 'btn' }, 'Hint');
  const solBtn = h('button', { class: 'btn btn-ghost' }, 'Show solution');
  const resetBtn = h('button', { class: 'btn btn-ghost', title: 'Restore the starting code' }, 'Reset code');
  const runBtn = h('button', { class: 'btn btn-run' }, 'Run ', h('kbd', {}, navigator.platform.includes('Mac') ? '⌘↵' : 'Ctrl↵'));

  runBtn.addEventListener('click', run);
  hintBtn.addEventListener('click', () => {
    hintsShown = Math.min(hintsShown + 1, level.hints.length);
    paintHints();
  });
  solBtn.addEventListener('click', () => {
    showSolution = true;
    if (!solved.has(level.id)) {
      peeked.add(level.id);
      saveProgress();
    }
    paintHints();
  });
  resetBtn.addEventListener('click', () => {
    editor.set(level.starter);
    store.set('code.' + level.id, level.starter);
    editor.focus();
  });

  function paintHints() {
    hintBox.replaceChildren(...level.hints.slice(0, hintsShown).map((t, i) => h('p', { class: 'hint' }, h('b', {}, `Hint ${i + 1}. `), t)));
    if (showSolution) {
      const pre = h('pre', { class: 'solution' }, level.solution);
      const use = h('button', { class: 'btn btn-ghost btn-small' }, 'Put in editor');
      use.addEventListener('click', () => {
        editor.set(level.solution);
        store.set('code.' + level.id, level.solution);
      });
      hintBox.append(h('div', { class: 'solution-box' }, h('b', {}, 'One solution'), pre, use));
    }
    hintBtn.toggleAttribute('disabled', hintsShown >= level.hints.length);
    hintBtn.textContent = hintsShown >= level.hints.length ? 'No more hints' : `Hint (${level.hints.length - hintsShown})`;
  }

  function run() {
    results = runLevel(level, editor.get());
    const firstErr = results.find((r) => r.error);
    if (firstErr?.error) {
      const { line, col } = lineCol(editor.get(), firstErr.error.pos);
      errBox.hidden = false;
      errBox.replaceChildren(h('b', {}, `Line ${line}, col ${col}: `), firstErr.error.message);
      editor.setError(firstErr.error.pos);
    } else {
      errBox.hidden = true;
      editor.setError(null);
    }
    const failing = results.findIndex((r) => !r.pass);
    selected = failing >= 0 ? failing : Math.min(selected, results.length - 1);
    if (results.every((r) => r.pass) && !solved.has(level.id)) {
      solved.add(level.id);
      if (!showSolution) peeked.delete(level.id);
      saveProgress();
      $('.side', app).replaceWith(sidebar(level));
    }
    paintResults();
  }

  function paintResults() {
    const list = results ?? previewCases(level);
    const allPass = !!results && results.every((r) => r.pass);
    const passed = results ? results.filter((r) => r.pass).length : 0;

    const summary = !results
      ? h('div', { class: 'summary summary-idle' }, h('b', {}, `${list.length} test case${list.length > 1 ? 's' : ''}`), level.kind === 'program' && list.length > 1 ? ' — some start from random values, so your code has to work for all of them.' : ' — run your code to check it.')
      : allPass
        ? h('div', { class: 'summary summary-pass' }, h('b', {}, 'Solved! '), `All ${list.length} cases pass.`, idx < LEVELS.length - 1 ? h('a', { class: 'btn btn-run', href: `#/level/${LEVELS[idx + 1].id}` }, 'Next level →') : h('span', {}, ' That was the last one — try the Sandbox.'))
        : h('div', { class: 'summary summary-fail' }, h('b', {}, `${passed} of ${list.length} pass.`), ' Pick a red case to see what went wrong.');

    const tabs = h('div', { class: 'case-tabs', role: 'tablist' });
    list.forEach((r, i) => {
      const t = h('button', { role: 'tab', class: 'case-tab' + (results ? (r.pass ? ' pass' : ' fail') : ''), 'aria-selected': String(i === selected) }, h('span', { class: 'case-mark' }, results ? (r.pass ? '✓' : '✗') : String(i + 1)), r.label);
      t.addEventListener('click', () => {
        selected = i;
        paintResults();
      });
      tabs.append(t);
    });

    const r = list[selected];
    const detail = h('div', { class: 'case-detail', role: 'tabpanel' });
    if (r.problems.length) detail.append(h('ul', { class: 'problems' }, ...r.problems.map((p) => h('li', {}, p))));
    const notes = r.notes.filter((n) => n.level !== 'ub' || level.allowUB);
    if (notes.length) detail.append(h('ul', { class: 'notes' }, ...notes.map((n) => h('li', { class: 'note-' + n.level }, n.msg))));

    if (level.kind === 'expr' && r.after?.value !== undefined) {
      const v = r.after.value;
      detail.append(renderRegister({ key: 'expr', after: v, compact: true }));
      if (level.truthy) detail.append(h('p', { class: 'truth' }, 'As a condition: ', h('b', {}, v !== 0 ? 'true' : 'false')));
    }
    const regs = h('div', { class: 'regs' });
    for (const key of level.show) {
      const before = key.startsWith('var:') ? r.beforeVars[key.slice(4)] : r.before[key];
      const after = r.after ? (key.startsWith('var:') ? r.after.vars[key.slice(4)] : r.after.regs[key]) : before;
      regs.append(renderRegister({ key, before: r.after ? before : undefined, after }));
    }
    if (level.show.length) {
      detail.append(h('h4', { class: 'regs-title' }, r.after ? 'Before → after' : 'Starting state'), regs);
    }
    if (level.board) detail.append(renderBoard({ chip: r.after?.chip ?? new Chip(r.beforeState) }));

    resultCol.replaceChildren(summary, tabs, detail);
  }

  const task = h(
    'section',
    { class: 'col-task' },
    h('div', { class: 'crumb' }, `${level.chapter} · level ${idx + 1} of ${LEVELS.length}`),
    h('h1', {}, level.title, solved.has(level.id) ? h('span', { class: 'solved-badge' }, 'solved') : null),
    h('p', { class: 'goal' }, level.goal),
    h('div', { class: 'brief', html: level.brief }),
    h('div', { class: 'editor-box' }, h('div', { class: 'editor-label' }, level.kind === 'expr' ? 'Expression' : 'Code'), editor.el, errBox, h('div', { class: 'toolbar' }, runBtn, hintBtn, solBtn, resetBtn)),
    hintBox,
    h(
      'nav',
      { class: 'pager' },
      idx > 0 ? h('a', { href: `#/level/${LEVELS[idx - 1].id}` }, '← ' + LEVELS[idx - 1].title) : h('span'),
      idx < LEVELS.length - 1 ? h('a', { href: `#/level/${LEVELS[idx + 1].id}` }, LEVELS[idx + 1].title + ' →') : h('span'),
    ),
  );

  app.replaceChildren(h('div', { class: 'layout' }, sidebar(level), h('main', { class: 'level' }, task, resultCol)));
  paintHints();
  paintResults();
  window.scrollTo(0, 0);
  if (matchMedia('(min-width: 1000px)').matches) editor.focus();
}

// ───────────── sandbox
const sb: { state: ChipState; prev: Record<string, number>; vars: Record<string, Var>; prevVars: Record<string, number> } = {
  state: resetState(),
  prev: {},
  vars: {},
  prevVars: {},
};
sb.prev = snapshot(new Chip(sb.state));

function showSandbox() {
  const editor = createEditor({
    onChange: (v) => store.set('sandbox', v),
    onRun: run,
    rows: 8,
    placeholder: 'Any statements. State carries over between runs.',
  });
  editor.set(store.get('sandbox', '// Anything goes. State persists between runs.\nRCC->APB2PCENR |= RCC_APB2Periph_GPIOC | RCC_APB2Periph_GPIOD;\n\nGPIOC->CFGLR &= ~(0xf << (4*1));\nGPIOC->CFGLR |= (GPIO_Speed_10MHz | GPIO_CNF_OUT_PP) << (4*1);\n\nGPIOC->BSHR = (1 << 1);\n'));

  const errBox = h('div', { class: 'code-error', hidden: '' });
  const notesBox = h('div');
  const boardBox = h('div');
  const regsBox = h('section', { class: 'col-result sandbox-regs' });
  const evalIn = h('input', { class: 'eval-in', placeholder: 'e.g. ~(0xF << 4)  or  GPIOD->INDR & (1 << 2)', 'aria-label': 'Expression to evaluate', spellcheck: 'false', autocomplete: 'off' }) as HTMLInputElement;
  const evalOut = h('div', { class: 'eval-out' });

  function chip() {
    return new Chip(sb.state);
  }

  function run() {
    sb.prev = snapshot(chip());
    sb.prevVars = Object.fromEntries(Object.entries(sb.vars).map(([k, v]) => [k, v.value]));
    const c = chip();
    const res = runProgram(editor.get(), c, {});
    // Declarations are local to one run; redeclaring across runs would be an error otherwise.
    if (res.ok) {
      sb.state = c.state;
      sb.vars = Object.fromEntries(res.interp.vars);
      errBox.hidden = true;
      editor.setError(null);
    } else {
      const { line, col } = lineCol(editor.get(), res.error!.pos);
      errBox.hidden = false;
      errBox.replaceChildren(h('b', {}, `Line ${line}, col ${col}: `), res.error!.message, h('div', { class: 'muted' }, 'Nothing was applied.'));
      editor.setError(res.error!.pos);
    }
    const notes = res.interp.allNotes();
    notesBox.replaceChildren(notes.length ? h('ul', { class: 'notes' }, ...notes.map((n) => h('li', { class: 'note-' + n.level }, n.msg))) : '');
    paint();
    doEval();
  }

  function doEval() {
    const src = evalIn.value.trim();
    if (!src) return evalOut.replaceChildren(h('span', { class: 'muted' }, 'Result shows here in hex, decimal and binary.'));
    const vars = Object.fromEntries(Object.entries(sb.vars).map(([k, v]) => [k, { ...v }]));
    const r = runExpression(src, chip(), vars);
    if (!r.ok) return evalOut.replaceChildren(h('span', { class: 'eval-err' }, r.error!.message));
    const v = r.value!;
    evalOut.replaceChildren(
      renderRegister({ key: 'expr', after: v.v, compact: true }),
      h('div', { class: 'muted' }, `type: ${v.u ? 'unsigned int' : 'int'}${!v.u && (v.v | 0) < 0 ? ` · as int: ${v.v | 0}` : ''}`),
      ...r.interp.allNotes().map((n) => h('div', { class: 'note-inline note-' + n.level }, n.msg)),
    );
  }
  evalIn.addEventListener('input', doEval);

  function paint() {
    const now = snapshot(chip());
    boardBox.replaceChildren(
      renderBoard({
        chip: chip(),
        interactive: true,
        onPress: (down) => {
          sb.state.external.PD2 = down ? 'low' : 'float';
          sb.prev = now;
          paint();
          doEval();
        },
      }),
    );
    const groups: [string, string[]][] = [
      ['RCC', REGS.filter((r) => r.periph === 'RCC').map((r) => `RCC->${r.name}`)],
      ['GPIOC', REGS.filter((r) => r.periph === 'GPIOC').map((r) => `GPIOC->${r.name}`)],
      ['GPIOD', REGS.filter((r) => r.periph === 'GPIOD').map((r) => `GPIOD->${r.name}`)],
      ['GPIOA', REGS.filter((r) => r.periph === 'GPIOA').map((r) => `GPIOA->${r.name}`)],
    ];
    const toggler = (key: string) => (bit: number) => {
      sb.prev = snapshot(chip());
      sb.state.regs[key] = (sb.state.regs[key] ^ (1 << bit)) >>> 0;
      paint();
      doEval();
    };
    const blocks = groups.map(([name, keys]) => {
      const d = h('details', { class: 'reg-group', ...(name === 'GPIOA' ? {} : { open: '' }) }, h('summary', {}, name, name === 'GPIOA' ? h('span', { class: 'muted' }, ' — only PA1/PA2 exist on F4P6') : null));
      for (const key of keys) {
        const def = REGS.find((r) => `${r.periph}->${r.name}` === key)!;
        d.append(renderRegister({ key, before: sb.prev[key], after: now[key], onToggle: def.access === 'rw' ? toggler(key) : undefined, compact: true }));
      }
      return d;
    });
    const varKeys = Object.keys(sb.vars);
    const varBlock = varKeys.length
      ? h('details', { class: 'reg-group', open: '' }, h('summary', {}, 'Variables'), ...varKeys.map((k) => renderRegister({ key: 'var:' + k, before: sb.prevVars[k], after: sb.vars[k].value, compact: true })))
      : null;
    regsBox.replaceChildren(h('p', { class: 'muted small' }, 'Click any bit of a read/write register to poke it, like a debugger would.'), ...(varBlock ? [varBlock] : []), ...blocks);
  }

  const resetBtn = h('button', { class: 'btn btn-ghost' }, 'Reset chip');
  resetBtn.addEventListener('click', () => {
    sb.state = resetState();
    sb.vars = {};
    sb.prev = snapshot(chip());
    sb.prevVars = {};
    notesBox.replaceChildren();
    paint();
    doEval();
  });
  const runBtn = h('button', { class: 'btn btn-run' }, 'Run ', h('kbd', {}, navigator.platform.includes('Mac') ? '⌘↵' : 'Ctrl↵'));
  runBtn.addEventListener('click', run);

  const left = h(
    'section',
    { class: 'col-task' },
    h('div', { class: 'crumb' }, 'Free play'),
    h('h1', {}, 'Sandbox'),
    h('p', { class: 'goal' }, 'A whole simulated CH32V003. Write anything, run it, poke bits, press the button.'),
    h('div', { class: 'editor-box' }, h('div', { class: 'editor-label' }, 'Code'), editor.el, errBox, h('div', { class: 'toolbar' }, runBtn, resetBtn)),
    notesBox,
    h('div', { class: 'editor-box' }, h('div', { class: 'editor-label' }, 'Evaluate'), evalIn, evalOut),
    boardBox,
  );
  app.replaceChildren(h('div', { class: 'layout layout-sandbox' }, h('main', { class: 'level' }, left, regsBox)));
  paint();
  doEval();
  window.scrollTo(0, 0);
}

route();
