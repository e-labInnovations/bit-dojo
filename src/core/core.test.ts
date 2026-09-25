import { describe, expect, it } from 'vitest';
import { Chip, resetState } from './chip';
import { runExpression, runProgram } from './interp';
import { LEVELS } from './levels';
import { runLevel } from './runner';

const evalExpr = (src: string) => {
  const r = runExpression(src, new Chip(resetState()));
  if (!r.ok) throw r.error;
  return { value: r.value!.v, notes: r.interp.allNotes() };
};

describe('C semantics', () => {
  it('follows C precedence', () => {
    expect(evalExpr('1 << 4 + 1').value).toBe(32); // + binds tighter than <<
    expect(evalExpr('6 & 4 == 4').value).toBe(0); // == binds tighter than &
    expect(evalExpr('1 | 2 ^ 3 & 1').value).toBe(1 | (2 ^ (3 & 1)));
  });

  it('does 32-bit bit ops', () => {
    expect(evalExpr('~(0xF << 4)').value).toBe(0xffffff0f);
    expect(evalExpr('0xFFFFFFFF + 1').value).toBe(0);
    expect(evalExpr('-1 >> 4').value).toBe(0xffffffff); // arithmetic shift on int
    expect(evalExpr('0xFFFFFFFF >> 4').value).toBe(0x0fffffff); // logical on unsigned
    expect(evalExpr('(uint8_t)0x1FF').value).toBe(0xff);
    expect(evalExpr('0b1010').value).toBe(10);
  });

  it('compares with the usual conversions', () => {
    expect(evalExpr('-1 < 0').value).toBe(1);
    expect(evalExpr('-1 < 0u').value).toBe(0); // -1 becomes 0xFFFFFFFF
  });

  it('flags undefined behaviour', () => {
    expect(evalExpr('1 << 31').notes.some((n) => n.level === 'ub')).toBe(true);
    expect(evalExpr('1u << 31').notes).toHaveLength(0);
    expect(() => evalExpr('1 << 32')).toThrow(/undefined behaviour/);
  });

  it('rejects oversized decimal literals', () => {
    expect(() => evalExpr('3000000000')).toThrow(/long long/);
    expect(evalExpr('0x80000000').value).toBe(0x80000000);
  });
});

describe('chip model', () => {
  it('ignores GPIO writes while the clock is off', () => {
    const chip = new Chip(resetState());
    runProgram('GPIOC->CFGLR = 0;', chip);
    expect(chip.state.regs['GPIOC->CFGLR']).toBe(0x44444444);
    expect(chip.notes[0].msg).toMatch(/clock is off/);
  });

  it('BSHR sets the low half and clears via the high half', () => {
    const chip = new Chip(resetState());
    const r = runProgram('RCC->APB2PCENR |= RCC_APB2Periph_GPIOC; GPIOC->OUTDR = 0xF0; GPIOC->BSHR = (1 << 1) | (1 << (16 + 4));', chip);
    expect(r.ok).toBe(true);
    expect(chip.state.regs['GPIOC->OUTDR']).toBe(0xe2);
  });

  it('reads a pulled-up button', () => {
    const s = resetState();
    s.regs['RCC->APB2PCENR'] = 0x20;
    s.regs['GPIOD->CFGLR'] = 0x44444844;
    s.regs['GPIOD->OUTDR'] = 0x4;
    expect(new Chip(s).inputs('GPIOD') & 4).toBe(4);
    s.external.PD2 = 'low';
    expect(new Chip(s).inputs('GPIOD') & 4).toBe(0);
  });
});

describe('levels', () => {
  for (const level of LEVELS) {
    it(`${level.id}: solution passes`, () => {
      const results = runLevel(level, level.solution);
      for (const r of results) expect(r.problems, `${level.id} / ${r.label}`).toEqual([]);
    });
    it(`${level.id}: starter fails`, () => {
      expect(runLevel(level, level.starter).some((r) => !r.pass)).toBe(true);
    });
  }

  it('catches = instead of |=', () => {
    const set = LEVELS.find((l) => l.id === 'set-bit')!;
    expect(runLevel(set, 'reg = (1 << 3);').some((r) => !r.pass)).toBe(true);
  });

  it('accepts alternative correct answers', () => {
    const btn = LEVELS.find((l) => l.id === 'read-button')!;
    expect(runLevel(btn, '(GPIOD->INDR & (1 << 2)) == 0').every((r) => r.pass)).toBe(true);
    const led = LEVELS.find((l) => l.id === 'blink-from-reset')!;
    const alt = 'RCC->APB2PCENR |= 0x10;\nGPIOC->CFGLR = (GPIOC->CFGLR & ~0xF0) | (0x3 << 4);\nGPIOC->OUTDR |= 2;';
    expect(runLevel(led, alt).every((r) => r.pass)).toBe(true);
  });
});
