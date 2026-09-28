import './style.css';
import { Chip, ChipState, REGS, cloneState, resetState, snapshot } from './core/chip';
import { Var, runExpression } from './core/interp';
import { CodeError } from './core/lexer';
import { LiveRun } from './core/live';
import { CHAPTERS, LEVELS, Level } from './core/levels';
import { CaseResult, buildState, rng, runLevel } from './core/runner';
import { renderBoard } from './ui/board';
import { CHEATSHEET } from './ui/cheatsheet';
import { Editor, createEditor, lineCol } from './ui/editor';
import { deriveGoal } from './core/goal';
import { renderExplain } from './ui/explain';
import { renderGoal } from './ui/goalview';
import { BitMark, renderRegister } from './ui/regview';

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
const about = $<HTMLDialogElement>('#about-dialog');
$('#about').addEventListener('click', () => about.showModal());
about.querySelector('[data-close]')!.addEventListener('click', () => about.close());
about.addEventListener('click', (e) => e.target === about && about.close());

// ───────────── Run button with an OS-aware ⌘/Ctrl + Enter hint
// Icons are Lucide's "command" and "corner-down-left" (ISC licence), inlined.
const IS_MAC = /mac|iphone|ipad/i.test(
  (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform || navigator.userAgent,
);
const LUCIDE = (paths: string) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
const ICON_COMMAND = LUCIDE('<path d="M15 6v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3"/>');
const ICON_ENTER = LUCIDE('<polyline points="9 10 4 15 9 20"/><path d="M20 4v7a4 4 0 0 1-4 4H4"/>');

// Decorative keycaps (hidden from screen readers; the control carries aria-keyshortcuts).
const keycaps = (...keys: string[]) => h('span', { class: 'kbd-group', 'aria-hidden': 'true' }, ...keys.map((k) => h('kbd', { html: k })));

function runButton(onClick: () => void) {
  const keys = keycaps(IS_MAC ? ICON_COMMAND : 'Ctrl', IS_MAC ? ICON_ENTER : 'Enter');
  const btn = h('button', {
    class: 'btn btn-run',
    'aria-keyshortcuts': IS_MAC ? 'Meta+Enter' : 'Control+Enter',
    title: IS_MAC ? 'Run (⌘ Return)' : 'Run (Ctrl + Enter)',
  }, 'Run', keys);
  btn.addEventListener('click', onClick);
  return btn;
}

// ───────────── level navigation keys: [ previous, ] next
// Ignored while typing in a field or with a dialog open. Esc in the editor blurs it.
let levelNav: { prev?: string; next?: string } | null = null;
document.addEventListener('keydown', (e) => {
  if (!levelNav || e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
  const t = e.target as HTMLElement;
  if (t.closest('input, textarea, select, [contenteditable]') || document.querySelector('dialog[open]')) return;
  const id = e.key === ']' ? levelNav.next : e.key === '[' ? levelNav.prev : undefined;
  if (!id) return;
  e.preventDefault();
  location.hash = `#/level/${id}`;
});

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
    return { label: c.label, before: snapshot(chip), beforeVars, beforeState: cloneState(state), pass: false, problems: [], notes: [], steps: [] };
  });
}

function showLevel(level: Level) {
  const idx = LEVELS.indexOf(level);
  const goal = deriveGoal(level);
  document.title = `${level.title} · Level ${idx + 1} · bit-dojo`;
  levelNav = { prev: LEVELS[idx - 1]?.id, next: LEVELS[idx + 1]?.id };
  let results: CaseResult[] | null = null;
  let selected = 0;
  let hintsShown = 0;
  let showSolution = false;
  let explainOpen = level.kind === 'expr'; // survives repaints within this level
  let autoplayExplain = false; // animate once right after Run

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
  const runBtn = runButton(run);

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
    autoplayExplain = true;
    const failing = results.findIndex((r) => !r.pass);
    selected = failing >= 0 ? failing : Math.min(selected, results.length - 1);
    if (results.every((r) => r.pass) && !solved.has(level.id)) {
      solved.add(level.id);
      if (!showSolution) peeked.delete(level.id);
      saveProgress();
      $('.side', app).replaceWith(sidebar(level));
    }
    paintResults();
    // Solved: put focus on "Next level" so Enter moves on.
    if (results.every((r) => r.pass)) resultCol.querySelector<HTMLElement>('.summary .btn-run')?.focus();
  }

  // Per-bit ✓/✗ against this case's exact expected value. Bits the level requires get a
  // mark either way; "keep" bits only get one when they were broken.
  function marksFor(key: string, before: number, after: number, r: CaseResult): (BitMark | null)[] | undefined {
    const target = goal.targets.find((t) => t.key === key);
    const chk = level.expect?.({ regs: r.before, vars: r.beforeVars, state: r.beforeState }).find((c) => 'key' in c && c.key === key);
    if (!target || !chk || !('key' in chk)) return undefined;
    const mask = chk.mask ?? 0xffffffff;
    return target.bits.map((g, b) => {
      if (!((mask >>> b) & 1) || g.k === 'any') return null;
      const want = (chk.value >>> b) & 1;
      const was = (before >>> b) & 1;
      const got = (after >>> b) & 1;
      const ok = got === want;
      if (g.k === 'keep') return ok ? null : { ok, tip: `must keep its value ${was}` };
      const rule =
        g.k === 'flip' ? `must flip (${was} → ${want})`
        : g.k === 'copy' ? `must copy ${g.from.replace('var:', '')} bit ${g.bit} (${want})`
        : `must be ${want}${ok && was === want ? ' — already was' : ''}`;
      return { ok, tip: rule };
    });
  }

  function paintResults() {
    const list = results ?? previewCases(level);
    const allPass = !!results && results.every((r) => r.pass);
    const passed = results ? results.filter((r) => r.pass).length : 0;

    const summary = !results
      ? h('div', { class: 'summary summary-idle' }, h('b', {}, `${list.length} test case${list.length > 1 ? 's' : ''}`), level.kind === 'program' && list.length > 1 ? ' — some start from random values, so your code has to work for all of them.' : ' — run your code to check it.')
      : allPass
        ? h('div', { class: 'summary summary-pass' }, h('b', {}, 'Solved! '), `All ${list.length} cases pass.`, idx < LEVELS.length - 1 ? h('a', { class: 'btn btn-run', href: `#/level/${LEVELS[idx + 1].id}`, 'aria-keyshortcuts': 'Enter ]', title: 'Next level (Enter, or ])' }, 'Next level →', keycaps(ICON_ENTER)) : h('span', {}, ' That was the last one — try the Sandbox.'))
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
    if (r.steps.length) {
      const box = h('details', { class: 'explain-box', ...(explainOpen ? { open: '' } : {}) }, h('summary', {}, `Step through how this case ran · ${r.steps.length} step${r.steps.length > 1 ? 's' : ''}`)) as HTMLDetailsElement;
      const fill = (autoplay: boolean) => box.querySelector('.explain') ?? box.append(renderExplain(r.steps, { autoplay }));
      if (explainOpen) fill(autoplayExplain);
      box.addEventListener('toggle', () => {
        explainOpen = box.open;
        if (box.open) fill(true);
      });
      detail.append(box);
    }
    autoplayExplain = false;
    const regs = h('div', { class: 'regs' });
    for (const key of level.show) {
      const before = key.startsWith('var:') ? r.beforeVars[key.slice(4)] : r.before[key];
      const after = r.after ? (key.startsWith('var:') ? r.after.vars[key.slice(4)] : r.after.regs[key]) : before;
      regs.append(renderRegister({ key, before: r.after ? before : undefined, after, marks: r.after ? marksFor(key, before, after, r) : undefined }));
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
    renderGoal(goal),
    h('div', { class: 'editor-box' }, h('div', { class: 'editor-label' }, level.kind === 'expr' ? 'Expression' : 'Code'), editor.el, errBox, h('div', { class: 'toolbar' }, runBtn, hintBtn, solBtn, resetBtn)),
    hintBox,
    h(
      'nav',
      { class: 'pager' },
      idx > 0 ? h('a', { href: `#/level/${LEVELS[idx - 1].id}`, 'aria-keyshortcuts': '[', title: 'Previous level ([)' }, keycaps('['), '← ' + LEVELS[idx - 1].title) : h('span'),
      idx < LEVELS.length - 1 ? h('a', { href: `#/level/${LEVELS[idx + 1].id}`, 'aria-keyshortcuts': ']', title: 'Next level (])' }, LEVELS[idx + 1].title + ' →', keycaps(']')) : h('span'),
    ),
  );

  app.replaceChildren(h('div', { class: 'layout' }, sidebar(level), h('main', { class: 'level' }, task, resultCol)));
  paintHints();
  paintResults();
  window.scrollTo(0, 0);
  if (matchMedia('(min-width: 1000px)').matches) editor.focus();
}

// ───────────── sandbox
const SETUP_PC1 = `RCC->APB2PCENR |= RCC_APB2Periph_GPIOC | RCC_APB2Periph_GPIOD;

// PC1: 10 MHz push-pull output (the LED)
GPIOC->CFGLR &= ~(0xf << (4*1));
GPIOC->CFGLR |= (GPIO_Speed_10MHz | GPIO_CNF_OUT_PP) << (4*1);`;
const SETUP_PD2 = `// PD2: input with pull-up (the button pulls it to GND)
GPIOD->CFGLR &= ~(0xf << (4*2));
GPIOD->CFGLR |= GPIO_CNF_IN_PUPD << (4*2);
GPIOD->BSHR = (1 << 2);`;

const EXAMPLES: { name: string; code: string }[] = [
  {
    name: 'Button toggles the LED',
    code: `// Press Run, then click the button on the board: each press flips the LED.
${SETUP_PC1}

${SETUP_PD2}

int last = 1;                          // 1 = released
while (1) {
    int now = (GPIOD->INDR >> 2) & 1;  // pressed reads 0
    if (last == 1 && now == 0) {       // falling edge = a new press
        GPIOC->OUTDR ^= (1 << 1);      // toggle the LED
    }
    last = now;
    Delay_Ms(10);
}
`,
  },
  {
    name: 'Blink',
    code: `// Blink the LED on PC1 twice a second. Press Stop to end it.
${SETUP_PC1}

while (1) {
    GPIOC->BSHR = (1 << 1);          // LED on
    Delay_Ms(250);
    GPIOC->BSHR = (1 << (16 + 1));   // LED off
    Delay_Ms(250);
}
`,
  },
  {
    name: 'LED on while the button is held',
    code: `// The LED follows the button: on while it's held down.
${SETUP_PC1}

${SETUP_PD2}

while (1) {
    if (GPIOD->INDR & (1 << 2))          // released: the pull-up reads 1
        GPIOC->BSHR = (1 << (16 + 1));   // LED off
    else                                 // pressed: the button pulls PD2 to 0
        GPIOC->BSHR = (1 << 1);          // LED on
    Delay_Ms(5);
}
`,
  },
  {
    name: 'Run once (no loop)',
    code: `// No loop: this runs once and stops. The step-through below shows every operation.
${SETUP_PC1}

GPIOC->BSHR = (1 << 1);
`,
  },
];

const sb: { state: ChipState; prev: Record<string, number>; vars: Record<string, Var>; prevVars: Record<string, number>; live: LiveRun | null } = {
  state: resetState(),
  prev: {},
  vars: {},
  prevVars: {},
  live: null,
};
sb.prev = snapshot(new Chip(sb.state));

// Leaving the sandbox stops a running program.
window.addEventListener('hashchange', () => {
  if (!location.hash.startsWith('#/sandbox')) sb.live?.stop();
});

function showSandbox() {
  document.title = 'Sandbox · bit-dojo — simulated CH32V003';
  levelNav = null;
  const editor = createEditor({
    onChange: (v) => store.set('sandbox', v),
    onRun: () => run(true),
    rows: 12,
    placeholder: 'Setup code, then while (1) { ... } to keep it running.',
  });
  editor.set(store.get('sandbox', EXAMPLES[0].code));

  const errBox = h('div', { class: 'code-error', hidden: '' });
  const status = h('div', { class: 'run-status', hidden: '', role: 'status' });
  const notesBox = h('div');
  const boardBox = h('div');
  const regsBox = h('section', { class: 'col-result sandbox-regs' });
  const evalIn = h('input', { class: 'eval-in', placeholder: 'e.g. ~(0xF << 4)  or  GPIOD->INDR & (1 << 2)', 'aria-label': 'Expression to evaluate', spellcheck: 'false', autocomplete: 'off' }) as HTMLInputElement;
  evalIn.value = '1 << 5';
  const evalOut = h('div', { class: 'eval-out' });
  const evalExplain = h('div', { class: 'eval-explain' });
  const runExplain = h('details', { class: 'explain-box', hidden: '' }) as HTMLDetailsElement;

  const examples = h('select', { class: 'examples', 'aria-label': 'Load an example' }, h('option', { value: '' }, 'Examples…'), ...EXAMPLES.map((e, i) => h('option', { value: String(i) }, e.name))) as HTMLSelectElement;
  examples.addEventListener('change', () => {
    const ex = EXAMPLES[Number(examples.value)];
    examples.value = '';
    if (!ex) return;
    const cur = editor.get().trim();
    if (cur && !EXAMPLES.some((e) => e.code.trim() === cur) && !confirm('Replace your code with this example?')) return;
    sb.live?.stop();
    editor.set(ex.code);
    store.set('sandbox', ex.code);
  });

  function chip() {
    return new Chip(sb.state);
  }

  const runBtn = runButton(() => (sb.live?.running ? sb.live.stop() : run(false)));
  const setRunning = (on: boolean) => {
    runBtn.firstChild!.textContent = on ? 'Stop' : 'Run';
    runBtn.classList.toggle('btn-stop', on);
  };

  function showNotes(list: { level: string; msg: string }[]) {
    notesBox.replaceChildren(list.length ? h('ul', { class: 'notes' }, ...list.map((n) => h('li', { class: 'note-' + n.level }, n.msg))) : '');
  }

  function showStatus(kind: 'running' | 'done' | 'stopped' | 'error', lr: LiveRun) {
    status.hidden = !lr.live && kind === 'done';
    const secs = (lr.delayMs / 1000).toFixed(lr.delayMs < 10000 ? 2 : 1);
    const stats = `${lr.passes.toLocaleString('en')} loop pass${lr.passes === 1 ? '' : 'es'} · ${secs} s in Delay_Ms`;
    const head = { running: 'Running', done: '✓ Finished', stopped: '■ Stopped', error: '✗ Stopped by an error' }[kind];
    status.className = `run-status run-${kind}`;
    status.replaceChildren(h('b', {}, kind === 'running' ? h('span', { class: 'live-dot', 'aria-hidden': 'true' }) : '', head), ` · ${stats}`, kind === 'running' ? h('span', { class: 'muted' }, ' — click the button on the board') : '');
  }

  // restart = Cmd/Ctrl+Enter: always (re)start with the current code.
  function run(restart: boolean) {
    if (sb.live?.running) {
      sb.live.stop();
      if (!restart) return;
    }
    sb.prev = snapshot(chip());
    sb.prevVars = Object.fromEntries(Object.entries(sb.vars).map(([k, v]) => [k, v.value]));
    const c = chip();
    sb.state = c.state; // share the state object: button presses and bit pokes reach the running code
    let lr: LiveRun;
    try {
      lr = new LiveRun(editor.get(), c, {
        onFrame: () => {
          sb.vars = Object.fromEntries(lr.interp.vars);
          showNotes(lr.interp.allNotes());
          showStatus('running', lr);
          paint();
        },
        onEnd: (why, error) => {
          setRunning(false);
          sb.vars = Object.fromEntries(lr.interp.vars);
          showNotes(lr.interp.allNotes());
          showStatus(why, lr);
          if (error) {
            const { line, col } = lineCol(editor.get(), error.pos);
            errBox.hidden = false;
            errBox.replaceChildren(h('b', {}, `Line ${line}, col ${col}: `), error.message);
            editor.setError(error.pos);
          }
          const steps = lr.interp.trace;
          runExplain.hidden = lr.live || !steps.length;
          if (!runExplain.hidden) runExplain.replaceChildren(h('summary', {}, `Step through this run · ${steps.length} step${steps.length === 1 ? '' : 's'}`), renderExplain(steps, { autoplay: runExplain.open }));
          paint();
          doEval();
        },
      });
    } catch (e) {
      if (!(e instanceof CodeError)) throw e;
      const { line, col } = lineCol(editor.get(), e.pos);
      errBox.hidden = false;
      errBox.replaceChildren(h('b', {}, `Line ${line}, col ${col}: `), e.message, h('div', { class: 'muted' }, 'Nothing was run.'));
      editor.setError(e.pos);
      return;
    }
    errBox.hidden = true;
    editor.setError(null);
    runExplain.hidden = true;
    sb.live = lr;
    setRunning(true);
    lr.start();
    if (lr.running) showStatus('running', lr);
  }

  function doEval(autoplay = false) {
    const src = evalIn.value.trim();
    evalExplain.replaceChildren();
    if (!src) return evalOut.replaceChildren(h('span', { class: 'muted' }, 'Result shows here in hex, decimal and binary. Press Enter to animate it step by step.'));
    const vars = Object.fromEntries(Object.entries(sb.vars).map(([k, v]) => [k, { ...v }]));
    const r = runExpression(src, chip(), vars);
    if (!r.ok) return evalOut.replaceChildren(h('span', { class: 'eval-err' }, r.error!.message));
    evalExplain.append(h('div', { class: 'editor-label' }, 'Step by step'), renderExplain(r.interp.trace, { autoplay }));
    const v = r.value!;
    evalOut.replaceChildren(
      renderRegister({ key: 'expr', after: v.v, compact: true }),
      h('div', { class: 'muted' }, `type: ${v.u ? 'unsigned int' : 'int'}${!v.u && (v.v | 0) < 0 ? ` · as int: ${v.v | 0}` : ''}`),
      ...r.interp.allNotes().map((n) => h('div', { class: 'note-inline note-' + n.level }, n.msg)),
    );
  }
  evalIn.addEventListener('input', () => doEval());
  evalIn.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      doEval(true);
    }
  });

  function paint() {
    const now = snapshot(chip());
    boardBox.replaceChildren(
      renderBoard({
        chip: chip(),
        interactive: true,
        onPress: (down) => {
          sb.state.external.PD2 = down ? 'low' : 'float';
          if (sb.live?.running) return sb.live.refresh();
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
    sb.live?.stop();
    sb.state = resetState();
    sb.vars = {};
    sb.prev = snapshot(chip());
    sb.prevVars = {};
    notesBox.replaceChildren();
    status.hidden = true;
    paint();
    doEval();
  });

  const left = h(
    'section',
    { class: 'col-task' },
    h('div', { class: 'crumb' }, 'Free play'),
    h('h1', {}, 'Sandbox'),
    h('p', { class: 'goal', html: 'A whole simulated CH32V003. Put setup code first, then <code>while (1) { … }</code>: it keeps running, so the board button really works. <code>Delay_Ms()</code> really waits.' }),
    h('div', { class: 'editor-box' }, h('div', { class: 'editor-head' }, h('div', { class: 'editor-label' }, 'Code'), examples), editor.el, errBox, h('div', { class: 'toolbar' }, runBtn, resetBtn), status),
    boardBox,
    notesBox,
    runExplain,
    h('div', { class: 'editor-box' }, h('div', { class: 'editor-label' }, 'Evaluate'), evalIn, evalOut, evalExplain),
  );
  app.replaceChildren(h('div', { class: 'layout layout-sandbox' }, h('main', { class: 'level' }, left, regsBox)));
  paint();
  doEval();
  window.scrollTo(0, 0);
}

route();
