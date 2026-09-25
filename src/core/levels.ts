// The curriculum. Every level runs against several starting states — some random —
// so code that only works for one lucky value (e.g. `=` instead of `|=`) fails.

import { ChipState } from './chip';
import type { CType } from './parser';
import type { After, Case, Check, Rng } from './runner';

export interface Before {
  regs: Record<string, number>;
  vars: Record<string, number>;
  state: ChipState;
}

export interface Level {
  id: string;
  chapter: string;
  title: string;
  kind: 'program' | 'expr';
  truthy?: boolean; // expr levels: only zero / non-zero matters
  goal: string; // one line, shown above the editor
  brief: string; // HTML
  starter: string;
  show: string[]; // registers ("GPIOC->CFGLR") or variables ("var:reg") to display
  vars?: Record<string, CType>;
  board?: boolean;
  seed: number;
  cases: (r: Rng) => Case[];
  expect?: (b: Before) => Check[];
  expectValue?: (b: Before) => number;
  allowUB?: boolean;
  hints: string[];
  solution: string;
}

const u32 = (r: Rng) => Math.floor(r() * 0x100000000) >>> 0;
const subset = (r: Rng, mask: number) => (u32(r) & mask) >>> 0;
const nibbles = (r: Rng) => u32(r);

const APB2_VALID = 0x5a35;
const IOPC = 0x10;
const IOPD = 0x20;

// A few random cases plus fixed ones that pin down the edges.
function withRandom(r: Rng, fixed: Case[], n: number, make: (r: Rng) => Omit<Case, 'label'>): Case[] {
  const out = [...fixed];
  for (let i = 0; i < n; i++) out.push({ label: `Random ${i + 1}`, ...make(r) });
  return out;
}

const regVarCases = (r: Rng, fixed: [string, number][] = []) =>
  withRandom(r, fixed.map(([label, v]) => ({ label, vars: { reg: v } })), 4, (r) => ({ vars: { reg: u32(r) } }));

const ledOn = (a: After) => a.chip.drive('GPIOC', 1) === 'high';

const buttonCases = (r: Rng): Case[] => {
  const make = (pressed: boolean, label: string): Case => {
    // PD2 = pull-up input; the other PD pins are floating inputs with random levels.
    let cfg = 0x44444444;
    cfg = (cfg & ~0xf00) | 0x800;
    const external: Record<string, 'low' | 'high' | 'float'> = {};
    for (let p = 0; p < 8; p++) if (p !== 2) external[`PD${p}`] = r() < 0.5 ? 'low' : 'high';
    external.PD2 = pressed ? 'low' : 'float';
    return { label, regs: { 'RCC->APB2PCENR': IOPD | IOPC, 'GPIOD->CFGLR': cfg, 'GPIOD->OUTDR': 0x04 }, external };
  };
  return [make(true, 'Pressed'), make(false, 'Released'), make(true, 'Pressed (noisy pins)'), make(false, 'Released (noisy pins)'), make(true, 'Pressed again')];
};

export const LEVELS: Level[] = [
  // ───────────────────────── Chapter 1
  {
    id: 'one-bit', chapter: 'Bits & hex', title: 'One bit', kind: 'expr', seed: 1,
    goal: 'Write an expression with only bit 5 set.',
    brief: `<p>Bits are numbered from the right, starting at <b>0</b>. <code>1 &lt;&lt; n</code> moves a single 1 into position <i>n</i>. Every register trick is built on this.</p>`,
    starter: '', show: [], cases: () => [{ label: 'Value' }],
    expectValue: () => 1 << 5,
    hints: ['Bit 5 is worth 2⁵ = 32 = 0x20.', 'Use the shift operator: 1 << something.'],
    solution: '1 << 5',
  },
  {
    id: 'nibble-mask', chapter: 'Bits & hex', title: 'A nibble mask', kind: 'expr', seed: 2,
    goal: 'Write a mask with bits 4, 5, 6 and 7 set — nothing else.',
    brief: `<p>One hex digit = 4 bits (a <i>nibble</i>). <code>0xF</code> is <code>1111</code>. Shift it to put four ones wherever you need them. That's how you target one pin's 4-bit slot in <code>CFGLR</code>.</p>`,
    starter: '', show: [], cases: () => [{ label: 'Value' }],
    expectValue: () => 0xf0,
    hints: ['0xF is four 1s in bits 0-3.', 'Move them up by 4.'],
    solution: '0xF << 4',
  },
  {
    id: 'everything-but', chapter: 'Bits & hex', title: 'Everything but', kind: 'expr', seed: 3,
    goal: 'Write a value with every bit set except bits 4-7.',
    brief: `<p><code>~</code> flips every bit. <code>~mask</code> gives you the "keep everything except this" mask used for clearing: <code>reg &amp;= ~mask</code>.</p>`,
    starter: '', show: [], cases: () => [{ label: 'Value' }],
    expectValue: () => ~0xf0 >>> 0,
    hints: ['Start from the mask of the previous level.', 'Invert it with ~ (use parentheses!).'],
    solution: '~(0xF << 4)',
  },
  {
    id: 'place-field', chapter: 'Bits & hex', title: 'Place a field', kind: 'expr', seed: 4,
    goal: 'Put the 4-bit value 0b1001 into bits 8-11 (everything else 0).',
    brief: `<p>Fields are small numbers living inside a register. To put value <i>v</i> into a field starting at bit <i>lsb</i>: <code>v &lt;&lt; lsb</code>. Pin 2's <code>CFGLR</code> slot starts at bit 8.</p>`,
    starter: '', show: [], cases: () => [{ label: 'Value' }],
    expectValue: () => 0x900,
    hints: ['0b1001 is 9.', 'The field starts at bit 8, i.e. 4*2.'],
    solution: '0x9 << (4*2)',
  },

  // ───────────────────────── Chapter 2
  {
    id: 'set-bit', chapter: 'Set · clear · toggle · test', title: 'Set a bit', kind: 'program', seed: 5,
    goal: 'Set bit 3 of reg. Leave every other bit alone.',
    brief: `<p><b>OR</b> with a 1 forces a bit to 1; OR with 0 leaves it. So <code>reg |= mask</code> sets exactly the mask bits.</p><p>Your code runs against several random starting values of <code>reg</code>. <code>reg = (1 &lt;&lt; 3)</code> would pass one and wipe the rest.</p>`,
    starter: 'reg ', show: ['var:reg'], vars: { reg: 'uint32_t' },
    cases: (r) => regVarCases(r, [['All zeros', 0], ['Already set', 0x8]]),
    expect: (b) => [{ key: 'var:reg', value: (b.vars.reg | 8) >>> 0 }],
    hints: ['You need |= and (1 << 3).'],
    solution: 'reg |= (1 << 3);',
  },
  {
    id: 'clear-bit', chapter: 'Set · clear · toggle · test', title: 'Clear a bit', kind: 'program', seed: 6,
    goal: 'Clear bit 7 of reg. Leave every other bit alone.',
    brief: `<p><b>AND</b> with 0 forces a bit to 0; AND with 1 keeps it. Build a mask that is all 1s except bit 7 with <code>~</code>, then <code>&amp;=</code>.</p>`,
    starter: 'reg ', show: ['var:reg'], vars: { reg: 'uint32_t' },
    cases: (r) => regVarCases(r, [['All ones', 0xffffffff], ['Already clear', 0x7f]]),
    expect: (b) => [{ key: 'var:reg', value: (b.vars.reg & ~0x80) >>> 0 }],
    hints: ['~(1 << 7) is "everything except bit 7".', 'reg &= ~(1 << 7);'],
    solution: 'reg &= ~(1 << 7);',
  },
  {
    id: 'toggle-bit', chapter: 'Set · clear · toggle · test', title: 'Toggle a bit', kind: 'program', seed: 7,
    goal: 'Flip bit 0 of reg: 0 → 1, 1 → 0. Others unchanged.',
    brief: `<p><b>XOR</b> with 1 flips a bit; XOR with 0 leaves it. Handy for blinking without remembering state.</p>`,
    starter: 'reg ', show: ['var:reg'], vars: { reg: 'uint32_t' },
    cases: (r) => regVarCases(r, [['Bit 0 is 0', 0xaaaaaaaa], ['Bit 0 is 1', 0x55555555]]),
    expect: (b) => [{ key: 'var:reg', value: (b.vars.reg ^ 1) >>> 0 }],
    hints: ['The XOR operator is ^.'],
    solution: 'reg ^= (1 << 0);',
  },
  {
    id: 'test-bit', chapter: 'Set · clear · toggle · test', title: 'Test a bit', kind: 'expr', truthy: true, seed: 8,
    goal: 'Write an expression that is true (non-zero) exactly when bit 2 of reg is 1.',
    brief: `<p>AND with a single-bit mask keeps only that bit. The result is either 0 or the mask value — in C any non-zero value counts as true in an <code>if</code>.</p>`,
    starter: '', show: ['var:reg'], vars: { reg: 'uint32_t' },
    cases: (r) => regVarCases(r, [['Only bit 2', 0x4], ['All except bit 2', ~0x4 >>> 0]]),
    expectValue: (b) => (b.vars.reg >>> 2) & 1,
    hints: ['reg & (1 << 2)'],
    solution: 'reg & (1 << 2)',
  },
  {
    id: 'two-at-once', chapter: 'Set · clear · toggle · test', title: 'Two at once', kind: 'program', seed: 9,
    goal: 'Set bits 1 and 6 of reg, and clear bit 0. Others unchanged.',
    brief: `<p>Masks combine with <code>|</code>: <code>(1 &lt;&lt; 1) | (1 &lt;&lt; 6)</code> is a mask of two bits. This is exactly how <code>RCC_APB2Periph_GPIOC | RCC_APB2Periph_GPIOD</code> enables two clocks in one write.</p>`,
    starter: '', show: ['var:reg'], vars: { reg: 'uint32_t' },
    cases: (r) => regVarCases(r, [['All zeros', 0], ['All ones', 0xffffffff]]),
    expect: (b) => [{ key: 'var:reg', value: ((b.vars.reg | 0x42) & ~1) >>> 0 }],
    hints: ['Two statements are fine: one |= and one &=.'],
    solution: 'reg |= (1 << 1) | (1 << 6);\nreg &= ~(1 << 0);',
  },

  // ───────────────────────── Chapter 3
  {
    id: 'clear-field', chapter: 'Fields', title: 'Clear a field', kind: 'program', seed: 10,
    goal: 'Clear bits 4-7 of reg (make them 0000). Others unchanged.',
    brief: `<p>Same as clearing one bit, but the mask is wider. This is step 1 of configuring a pin: wipe its old 4-bit slot.</p>`,
    starter: 'reg ', show: ['var:reg'], vars: { reg: 'uint32_t' },
    cases: (r) => regVarCases(r, [['All ones', 0xffffffff], ['CFGLR reset value', 0x44444444]]),
    expect: (b) => [{ key: 'var:reg', value: (b.vars.reg & ~0xf0) >>> 0 }],
    hints: ['Mask: 0xF << 4. Invert it, AND it in.'],
    solution: 'reg &= ~(0xF << 4);',
  },
  {
    id: 'write-field', chapter: 'Fields', title: 'Write a field', kind: 'program', seed: 11,
    goal: 'Make bits 4-7 of reg hold the value 9 (0b1001). Others unchanged.',
    brief: `<p>The two-step dance: <b>clear</b> the field, then <b>OR</b> in the new value. Skipping the clear only works if the field happened to be 0 — the reset value of <code>CFGLR</code> is <code>0x44444444</code>, so it never is.</p>`,
    starter: '', show: ['var:reg'], vars: { reg: 'uint32_t' },
    cases: (r) => regVarCases(r, [['All ones', 0xffffffff], ['All zeros', 0]]),
    expect: (b) => [{ key: 'var:reg', value: ((b.vars.reg & ~0xf0) | 0x90) >>> 0 }],
    hints: ['Line 1: clear the field. Line 2: reg |= (9 << 4);'],
    solution: 'reg &= ~(0xF << 4);\nreg |= (9 << 4);',
  },
  {
    id: 'read-field', chapter: 'Fields', title: 'Read a field', kind: 'program', seed: 12,
    goal: 'Store the value of bits 8-11 of reg into val (as a number 0-15).',
    brief: `<p>Reading goes the other way: shift the field <b>down</b> to bit 0, then AND away everything above it. <code>val</code> starts with garbage, so don't <code>|=</code> into it.</p>`,
    starter: 'val = ', show: ['var:reg', 'var:val'], vars: { reg: 'uint32_t', val: 'uint32_t' },
    cases: (r) => withRandom(r, [{ label: 'Field = 0xA', vars: { reg: 0xa00, val: 0xdeadbeef } }], 4, (r) => ({ vars: { reg: u32(r), val: u32(r) } })),
    expect: (b) => [{ key: 'var:val', value: (b.vars.reg >>> 8) & 0xf }, { key: 'var:reg', value: b.vars.reg }],
    hints: ['reg >> 8 moves the field to the bottom.', 'Then & 0xF.'],
    solution: 'val = (reg >> 8) & 0xF;',
  },

  // ───────────────────────── Chapter 4
  {
    id: 'clock-on', chapter: 'Real CH32V003 registers', title: 'Wake up port C', kind: 'program', seed: 13, board: true,
    goal: 'Turn on the clock for GPIOC. Don\'t disturb the other peripherals.',
    brief: `<p>Every peripheral starts with its clock <b>off</b>. Until you set its bit in <code>RCC->APB2PCENR</code>, writes to it are silently ignored. ch32fun names the bit <code>RCC_APB2Periph_GPIOC</code> (<code>0x10</code>, bit 4).</p><p>Other code already enabled some peripherals — they must stay on.</p>`,
    starter: 'RCC->APB2PCENR ', show: ['RCC->APB2PCENR'],
    cases: (r) => withRandom(r, [{ label: 'Reset' }, { label: 'USART + GPIOD on', regs: { 'RCC->APB2PCENR': 0x4020 } }], 3, (r) => ({ regs: { 'RCC->APB2PCENR': subset(r, APB2_VALID & ~IOPC) } })),
    expect: (b) => [{ key: 'RCC->APB2PCENR', value: (b.regs['RCC->APB2PCENR'] | IOPC) >>> 0 }],
    hints: ['Set one bit: |= RCC_APB2Periph_GPIOC'],
    solution: 'RCC->APB2PCENR |= RCC_APB2Periph_GPIOC;',
  },
  {
    id: 'pc1-output', chapter: 'Real CH32V003 registers', title: 'PC1 as output', kind: 'program', seed: 14, board: true,
    goal: 'Configure PC1 as a 10 MHz push-pull output. Other pins keep their setup.',
    brief: `<p><code>GPIOC->CFGLR</code> has 4 bits per pin; pin <i>n</i> lives at bits <code>4n+3 … 4n</code>. The low 2 bits are MODE (speed; 0 = input), the high 2 are CNF. ch32fun gives you both: <code>GPIO_Speed_10MHz | GPIO_CNF_OUT_PP</code> = <code>0x1</code>.</p><p>Clock is already on.</p>`,
    starter: '', show: ['GPIOC->CFGLR'],
    cases: (r) => withRandom(r, [{ label: 'Reset', regs: { 'RCC->APB2PCENR': IOPC } }], 4, (r) => ({ regs: { 'RCC->APB2PCENR': IOPC, 'GPIOC->CFGLR': nibbles(r) } })),
    expect: (b) => [{ key: 'GPIOC->CFGLR', value: ((b.regs['GPIOC->CFGLR'] & ~0xf0) | 0x10) >>> 0 }],
    hints: ['Clear the slot: GPIOC->CFGLR &= ~(0xf << (4*1));', 'Then OR in (GPIO_Speed_10MHz | GPIO_CNF_OUT_PP) << (4*1).'],
    solution: 'GPIOC->CFGLR &= ~(0xf << (4*1));\nGPIOC->CFGLR |= (GPIO_Speed_10MHz | GPIO_CNF_OUT_PP) << (4*1);',
  },
  {
    id: 'led-on-bshr', chapter: 'Real CH32V003 registers', title: 'LED on with BSHR', kind: 'program', seed: 15, board: true,
    goal: 'Drive PC1 high using GPIOC->BSHR. Other outputs unchanged.',
    brief: `<p><code>OUTDR |= …</code> works but takes three steps: read, modify, write. If an interrupt changes <code>OUTDR</code> between them, its change is lost.</p><p><code>BSHR</code> does it in one store: a 1 in bits 0-7 <b>sets</b> that pin, a 1 in bits 16-23 <b>clears</b> it, zeros do nothing. Plain <code>=</code> is correct here!</p>`,
    starter: 'GPIOC->BSHR = ', show: ['GPIOC->OUTDR', 'GPIOC->BSHR'],
    cases: (r) => withRandom(r, [{ label: 'All low', regs: { 'RCC->APB2PCENR': IOPC, 'GPIOC->CFGLR': 0x44444414 } }], 4, (r) => ({ regs: { 'RCC->APB2PCENR': IOPC, 'GPIOC->CFGLR': 0x11111111, 'GPIOC->OUTDR': subset(r, 0xfd) } })),
    expect: (b) => [
      { key: 'GPIOC->OUTDR', value: (b.regs['GPIOC->OUTDR'] | 2) >>> 0 },
      { label: 'uses BSHR', ok: (a) => a.writes.some((w) => w.key === 'GPIOC->BSHR') && !a.writes.some((w) => w.key === 'GPIOC->OUTDR'), why: 'Do it with a single write to GPIOC->BSHR (no OUTDR read-modify-write).' },
    ],
    hints: ['Bit 1 of BSHR sets PC1.', 'GPIOC->BSHR = (1 << 1);'],
    solution: 'GPIOC->BSHR = (1 << 1);',
  },
  {
    id: 'led-off-bshr', chapter: 'Real CH32V003 registers', title: 'LED off with BSHR', kind: 'program', seed: 16, board: true,
    goal: 'Drive PC1 low using GPIOC->BSHR. Other outputs unchanged.',
    brief: `<p>The upper half of <code>BSHR</code> is the <b>reset</b> half: bit <code>16 + n</code> clears pin <i>n</i>.</p>`,
    starter: 'GPIOC->BSHR = ', show: ['GPIOC->OUTDR', 'GPIOC->BSHR'],
    cases: (r) => withRandom(r, [{ label: 'All high', regs: { 'RCC->APB2PCENR': IOPC, 'GPIOC->CFGLR': 0x11111111, 'GPIOC->OUTDR': 0xff } }], 4, (r) => ({ regs: { 'RCC->APB2PCENR': IOPC, 'GPIOC->CFGLR': 0x11111111, 'GPIOC->OUTDR': subset(r, 0xff) | 2 } })),
    expect: (b) => [
      { key: 'GPIOC->OUTDR', value: (b.regs['GPIOC->OUTDR'] & ~2) >>> 0 },
      { label: 'uses BSHR', ok: (a) => a.writes.some((w) => w.key === 'GPIOC->BSHR') && !a.writes.some((w) => w.key === 'GPIOC->OUTDR'), why: 'Do it with a single write to GPIOC->BSHR.' },
    ],
    hints: ['Which bit of BSHR resets pin 1?', 'GPIOC->BSHR = (1 << (16 + 1));'],
    solution: 'GPIOC->BSHR = (1 << (16 + 1));',
  },
  {
    id: 'blink-from-reset', chapter: 'Real CH32V003 registers', title: 'From reset to light', kind: 'program', seed: 17, board: true,
    goal: 'Starting from reset: light the LED on PC1. Don\'t break anything else.',
    brief: `<p>All three steps from Lesson 04, no helpers: clock, pin config, output. Any speed works — the LED only cares that PC1 is a push-pull output driving high.</p>`,
    starter: '// 1. clock\n\n// 2. configure PC1\n\n// 3. drive it high\n', show: ['RCC->APB2PCENR', 'GPIOC->CFGLR', 'GPIOC->OUTDR'],
    cases: (r) => withRandom(r, [{ label: 'Reset' }], 3, (r) => ({ regs: { 'RCC->APB2PCENR': subset(r, APB2_VALID & ~IOPC) } })),
    expect: (b) => [
      { key: 'RCC->APB2PCENR', value: (b.regs['RCC->APB2PCENR'] | IOPC) >>> 0 },
      { key: 'GPIOC->CFGLR', value: b.regs['GPIOC->CFGLR'], mask: ~0xf0 >>> 0 },
      { label: 'LED on', ok: ledOn, why: 'The LED is not lit — PC1 must be a push-pull output with OUTDR bit 1 = 1.' },
    ],
    hints: ['Clock first — otherwise the GPIOC writes are ignored.', 'Copy your answers from the last three levels.'],
    solution: 'RCC->APB2PCENR |= RCC_APB2Periph_GPIOC;\nGPIOC->CFGLR &= ~(0xf << (4*1));\nGPIOC->CFGLR |= (GPIO_Speed_10MHz | GPIO_CNF_OUT_PP) << (4*1);\nGPIOC->BSHR = (1 << 1);',
  },
  {
    id: 'button-pullup', chapter: 'Real CH32V003 registers', title: 'Button input', kind: 'program', seed: 18, board: true,
    goal: 'Make PD2 an input with the internal pull-up enabled.',
    brief: `<p>The button connects PD2 to GND. Released, the pin would float — so enable the pull-up. In <code>GPIO_CNF_IN_PUPD</code> mode (<code>0x8</code>, MODE = 0) the <b>OUTDR</b> bit picks the direction: 1 = pull-up, 0 = pull-down.</p><p>GPIOD clock is on.</p>`,
    starter: '', show: ['GPIOD->CFGLR', 'GPIOD->OUTDR', 'GPIOD->INDR'],
    cases: (r) => withRandom(r, [{ label: 'Reset', regs: { 'RCC->APB2PCENR': IOPD | IOPC } }], 4, (r) => ({ regs: { 'RCC->APB2PCENR': IOPD | IOPC, 'GPIOD->CFGLR': nibbles(r), 'GPIOD->OUTDR': subset(r, 0xfb) } })),
    expect: (b) => [
      { key: 'GPIOD->CFGLR', value: ((b.regs['GPIOD->CFGLR'] & ~0xf00) | 0x800) >>> 0 },
      { key: 'GPIOD->OUTDR', value: (b.regs['GPIOD->OUTDR'] | 4) >>> 0 },
    ],
    hints: ['Pin 2 slot is bits 8-11: clear, then OR in GPIO_CNF_IN_PUPD << (4*2).', 'Then set OUTDR bit 2 — GPIOD->BSHR = (1 << 2); does it.'],
    solution: 'GPIOD->CFGLR &= ~(0xf << (4*2));\nGPIOD->CFGLR |= GPIO_CNF_IN_PUPD << (4*2);\nGPIOD->BSHR = (1 << 2);',
  },
  {
    id: 'read-button', chapter: 'Real CH32V003 registers', title: 'Is it pressed?', kind: 'expr', truthy: true, seed: 19, board: true,
    goal: 'Write an expression that is true when the button on PD2 is pressed.',
    brief: `<p><code>GPIOD->INDR</code> shows the real level on each pin. With the pull-up, released reads <b>1</b> and pressed reads <b>0</b> (the button shorts the pin to GND). The other PD pins are noise — ignore them.</p>`,
    starter: '', show: ['GPIOD->INDR'],
    cases: buttonCases,
    expectValue: (b) => (b.state.external.PD2 === 'low' ? 1 : 0),
    hints: ['Isolate bit 2 of GPIOD->INDR first.', 'Pressed means that bit is 0: use ! or == 0.'],
    solution: '!(GPIOD->INDR & (1 << 2))',
  },

  // ───────────────────────── Chapter 5
  {
    id: 'bug-clobber', chapter: 'Bug hunt', title: 'Where did the UART go?', kind: 'program', seed: 20, board: true,
    goal: 'This enables GPIOC but kills the serial port. Fix it.',
    brief: `<p>Someone's <code>printf</code> stopped working the moment they added the LED code. USART1, GPIOD and AFIO were already enabled.</p>`,
    starter: 'RCC->APB2PCENR = RCC_APB2Periph_GPIOC;', show: ['RCC->APB2PCENR'],
    cases: (r) => withRandom(r, [{ label: 'Serial running', regs: { 'RCC->APB2PCENR': 0x4021 } }], 3, (r) => ({ regs: { 'RCC->APB2PCENR': subset(r, APB2_VALID) } })),
    expect: (b) => [{ key: 'RCC->APB2PCENR', value: (b.regs['RCC->APB2PCENR'] | IOPC) >>> 0 }],
    hints: ['= replaces the whole register.'],
    solution: 'RCC->APB2PCENR |= RCC_APB2Periph_GPIOC;',
  },
  {
    id: 'bug-no-clear', chapter: 'Bug hunt', title: 'The LED won\'t light', kind: 'program', seed: 21, board: true,
    goal: 'PC1 should be a 50 MHz push-pull output. The LED stays dark. Fix it.',
    brief: `<p>Look at what the <code>CFGLR</code> slot for PC1 ends up as, and decode it: MODE is the low 2 bits, CNF the high 2.</p>`,
    starter: 'GPIOC->CFGLR |= (GPIO_Speed_50MHz | GPIO_CNF_OUT_PP) << (4*1);\nGPIOC->BSHR = (1 << 1);', show: ['GPIOC->CFGLR', 'GPIOC->OUTDR'],
    cases: (r) => withRandom(r, [{ label: 'Reset', regs: { 'RCC->APB2PCENR': IOPC } }], 3, (r) => ({ regs: { 'RCC->APB2PCENR': IOPC, 'GPIOC->CFGLR': nibbles(r) } })),
    expect: (b) => [
      { key: 'GPIOC->CFGLR', value: ((b.regs['GPIOC->CFGLR'] & ~0xf0) | 0x30) >>> 0 },
      { label: 'LED on', ok: ledOn, why: 'The LED is not lit.' },
    ],
    hints: ['Reset value 0x4 | 0x3 = 0x7 — CNF = 01 is open-drain.', 'Clear the slot first.'],
    solution: 'GPIOC->CFGLR &= ~(0xf << (4*1));\nGPIOC->CFGLR |= (GPIO_Speed_50MHz | GPIO_CNF_OUT_PP) << (4*1);\nGPIOC->BSHR = (1 << 1);',
  },
  {
    id: 'bug-precedence', chapter: 'Bug hunt', title: 'Never pressed', kind: 'expr', truthy: true, seed: 22, board: true,
    goal: 'This should be true when PD2 is pressed, but it never is. Fix it.',
    brief: `<p>In C, <code>==</code> binds tighter than <code>&amp;</code>. (This is a real, famous C wart — GCC's <code>-Wparentheses</code> warns about it.)</p>`,
    starter: 'GPIOD->INDR & (1 << 2) == 0', show: ['GPIOD->INDR'],
    cases: buttonCases,
    expectValue: (b) => (b.state.external.PD2 === 'low' ? 1 : 0),
    hints: ['What is (1 << 2) == 0?', 'Parenthesise the & part.'],
    solution: '(GPIOD->INDR & (1 << 2)) == 0',
  },
  {
    id: 'bug-no-clock', chapter: 'Bug hunt', title: 'Silent port', kind: 'program', seed: 23, board: true,
    goal: 'Perfect-looking code, dark LED. Fix it.',
    brief: `<p>Every line is right. Something is missing. Watch the notes after you run it.</p>`,
    starter: 'GPIOC->CFGLR &= ~(0xf << (4*1));\nGPIOC->CFGLR |= (GPIO_Speed_10MHz | GPIO_CNF_OUT_PP) << (4*1);\nGPIOC->BSHR = (1 << 1);', show: ['RCC->APB2PCENR', 'GPIOC->CFGLR', 'GPIOC->OUTDR'],
    cases: (r) => withRandom(r, [{ label: 'Reset' }], 2, (r) => ({ regs: { 'RCC->APB2PCENR': subset(r, APB2_VALID & ~IOPC) } })),
    expect: (b) => [
      { key: 'RCC->APB2PCENR', value: (b.regs['RCC->APB2PCENR'] | IOPC) >>> 0 },
      { label: 'LED on', ok: ledOn, why: 'The LED is not lit.' },
    ],
    hints: ['Unclocked peripherals ignore writes.', 'Add the clock enable — and it has to come first.'],
    solution: 'RCC->APB2PCENR |= RCC_APB2Periph_GPIOC;\nGPIOC->CFGLR &= ~(0xf << (4*1));\nGPIOC->CFGLR |= (GPIO_Speed_10MHz | GPIO_CNF_OUT_PP) << (4*1);\nGPIOC->BSHR = (1 << 1);',
  },
  {
    id: 'bug-bit31', chapter: 'Bug hunt', title: 'Bit 31', kind: 'program', seed: 24,
    goal: 'Set bit 31 of reg — without undefined behaviour.',
    brief: `<p><code>1</code> is a <b>signed</b> int. Shifting a 1 into bit 31 (the sign bit) is undefined behaviour — GCC usually gives you what you expect, until optimisation decides otherwise. Registers are unsigned; make your constants unsigned too.</p>`,
    starter: 'reg |= 1 << 31;', show: ['var:reg'], vars: { reg: 'uint32_t' },
    cases: (r) => regVarCases(r, [['All zeros', 0]]),
    expect: (b) => [{ key: 'var:reg', value: (b.vars.reg | 0x80000000) >>> 0 }],
    hints: ['The suffix u makes a literal unsigned.'],
    solution: 'reg |= 1u << 31;',
  },
];

export const CHAPTERS = [...new Set(LEVELS.map((l) => l.chapter))];
