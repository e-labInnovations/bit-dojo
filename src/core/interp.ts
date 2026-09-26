// Evaluates parsed C against a Chip, with 32-bit int/unsigned semantics as on RV32.
// Flags undefined behaviour (bad shift counts, shifting into the sign bit) as notes,
// and records a step-by-step trace of every operator for the visualizer.

import { Chip, MACROS, Note, PERIPHS } from './chip';
import { CodeError } from './lexer';
import { CType, Expr, LValue, Stmt, parseExpression, parseProgram, printExpr } from './parser';

export interface Val {
  v: number; // bit pattern, 0..2^32-1
  u: boolean; // unsigned?
}

export interface Var {
  type: CType;
  value: number;
}

// Where an operand's value came from, so the visualizer can label it.
export interface Operand {
  text: string;
  val: Val;
  from: 'literal' | 'macro' | 'reg' | 'var' | 'step';
  step?: number; // index into the trace when from === 'step'
}

export type Step =
  | { k: 'binary'; op: string; a: Operand; b: Operand; r: Val; text: string; notes: Note[] }
  | { k: 'unary'; op: string; a: Operand; r: Val; text: string; notes: Note[] }
  | { k: 'cast'; type: CType; a: Operand; r: Val; text: string; notes: Note[] }
  | { k: 'logic'; op: string; a: Operand; b?: Operand; r: Val; text: string; notes: Note[] } // b missing = short-circuited
  | { k: 'cond'; test: Operand; chosen: Operand; r: Val; text: string; notes: Note[] }
  | { k: 'value'; a: Operand; text: string; notes: Note[] } // a whole expression that is just one leaf
  | { k: 'write'; target: string; op: string; value: Operand; stored: number; effect?: string; text: string; notes: Note[] };

const INT_MAX = 0x7fffffff;
const toSigned = (v: number) => v | 0;

function narrow(type: CType, v: number): Val {
  switch (type) {
    case 'uint8_t': return { v: v & 0xff, u: false }; // promotes to int
    case 'uint16_t': return { v: v & 0xffff, u: false };
    case 'int8_t': return { v: ((v << 24) >> 24) >>> 0, u: false };
    case 'int16_t': return { v: ((v << 16) >> 16) >>> 0, u: false };
    case 'int': case 'int32_t': return { v: v >>> 0, u: false };
    case 'unsigned': case 'uint32_t': return { v: v >>> 0, u: true };
  }
}

export class Interp {
  vars = new Map<string, Var>();
  notes: Note[] = [];
  trace: Step[] = [];
  private noteSeen = new Set<string>();
  private steps = 0;
  private stepOf = new WeakMap<Expr, number>();

  constructor(
    public chip: Chip,
    vars: Record<string, Var> = {},
  ) {
    for (const [k, v] of Object.entries(vars)) this.vars.set(k, { ...v });
  }

  note(level: Note['level'], msg: string) {
    if (this.noteSeen.has(msg)) return;
    this.noteSeen.add(msg);
    this.notes.push({ level, msg });
  }

  allNotes(): Note[] {
    return [...this.notes, ...this.chip.notes];
  }

  // Notes raised since a mark() — attached to the step that caused them.
  private mark() {
    return { n: this.notes.length, c: this.chip.notes.length };
  }
  private since(m: { n: number; c: number }): Note[] {
    return [...this.notes.slice(m.n), ...this.chip.notes.slice(m.c)];
  }

  private operand(e: Expr, val: Val): Operand {
    const text = printExpr(e);
    if (e.k === 'num') return { text, val, from: 'literal' };
    if (e.k === 'member') return { text, val, from: 'reg' };
    if (e.k === 'ident') return { text, val, from: this.vars.has(e.name) ? 'var' : 'macro' };
    return { text, val, from: 'step', step: this.stepOf.get(e) };
  }

  private record(e: Expr | null, step: Step) {
    this.trace.push(step);
    if (e) this.stepOf.set(e, this.trace.length - 1);
  }

  run(stmts: Stmt[]) {
    for (const s of stmts) this.stmt(s);
  }

  private stmt(s: Stmt) {
    if (++this.steps > 10000) throw new CodeError('Too many steps', s.pos);
    switch (s.k) {
      case 'block': return this.run(s.body);
      case 'call': return; // Delay_Ms / Delay_Us: time doesn't matter here
      case 'expr':
        this.eval(s.expr);
        this.note('warn', 'A statement without = does nothing. Did you mean |= or &=?');
        return;
      case 'if':
        if (this.eval(s.test).v !== 0) this.stmt(s.then);
        else if (s.else) this.stmt(s.else);
        return;
      case 'decl': {
        if (this.vars.has(s.name)) throw new CodeError(`'${s.name}' already exists`, s.pos);
        if (MACROS[s.name] || PERIPHS.has(s.name)) throw new CodeError(`'${s.name}' is already a ch32fun name`, s.pos);
        const init = s.init ? this.eval(s.init) : { v: 0, u: false };
        if (!s.init) this.note('warn', `'${s.name}' has no initial value. In real C a local would hold garbage — here it's 0.`);
        const stored = narrow(s.type, init.v).v;
        this.vars.set(s.name, { type: s.type, value: stored });
        if (s.init) {
          this.record(null, { k: 'write', target: s.name, op: '=', value: this.operand(s.init, init), stored, text: `${s.type} ${s.name} = ${printExpr(s.init)}`, notes: [] });
        }
        return;
      }
      case 'assign': {
        const target = printExpr(s.target);
        let value: Val;
        let operand: Operand;
        if (s.op === '=') {
          value = this.eval(s.value);
          operand = this.operand(s.value, value);
        } else {
          // x op= y is x = x op y: record that binary step explicitly.
          const op = s.op.slice(0, -1);
          const a = this.eval(s.target);
          const b = this.eval(s.value);
          const m = this.mark();
          value = this.binop(op, a, b, s.pos);
          const text = printExpr({ k: 'binary', op, l: s.target, r: s.value, pos: s.pos });
          this.record(null, { k: 'binary', op, a: this.operand(s.target, a), b: this.operand(s.value, b), r: value, text, notes: this.since(m) });
          operand = { text, val: value, from: 'step', step: this.trace.length - 1 };
        }
        const m = this.mark();
        const effect = this.writeL(s.target, value.v);
        const stored = s.target.k === 'ident' ? this.vars.get(s.target.name)!.value : value.v;
        this.record(null, { k: 'write', target, op: s.op, value: operand, stored, effect, text: `${target} ${s.op} ${printExpr(s.value)}`, notes: this.since(m) });
        return;
      }
    }
  }

  private writeL(t: LValue, v: number): string | undefined {
    if (t.k === 'member') {
      this.periph(t.base, t.pos);
      const out = `${t.base}->OUTDR`;
      const before = this.chip.state.regs[out];
      try {
        this.chip.write(t.base, t.field, v);
      } catch (e) {
        throw new CodeError((e as Error).message, t.pos);
      }
      const after = this.chip.state.regs[out];
      if ((t.field === 'BSHR' || t.field === 'BCR') && before !== undefined) {
        const h = (x: number) => '0x' + x.toString(16).toUpperCase().padStart(2, '0');
        return before === after ? `${out} unchanged (${h(after)})` : `${out}: ${h(before)} → ${h(after)}`;
      }
      return;
    }
    const cur = this.vars.get(t.name);
    if (!cur) {
      if (MACROS[t.name]) throw new CodeError(`${t.name} is a constant macro — you can't assign to it`, t.pos);
      throw new CodeError(`'${t.name}' isn't declared. Declare it first, e.g. uint32_t ${t.name} = 0;`, t.pos);
    }
    const stored = narrow(cur.type, v).v;
    cur.value = stored;
    if (stored !== v >>> 0) return `${cur.type} keeps only its low bits`;
  }

  private periph(name: string, pos: number) {
    if (!PERIPHS.has(name)) throw new CodeError(`Unknown peripheral '${name}'. This chip model has RCC, GPIOA, GPIOC, GPIOD`, pos);
  }

  eval(e: Expr): Val {
    switch (e.k) {
      case 'num': return { v: e.value, u: e.unsigned };
      case 'ident': {
        const vr = this.vars.get(e.name);
        if (vr) return narrow(vr.type, vr.value);
        const m = MACROS[e.name];
        if (m) return { v: m.value, u: m.unsigned };
        if (PERIPHS.has(e.name)) throw new CodeError(`${e.name} is the whole peripheral. Pick a register, e.g. ${e.name === 'RCC' ? 'RCC->APB2PCENR' : e.name + '->OUTDR'}`, e.pos);
        if (/^P[ACD][0-7]$/.test(e.name)) throw new CodeError(`${e.name} is a ch32fun pin number for funPinMode(). With raw registers use the bit position, e.g. (1 << ${e.name[2]})`, e.pos);
        throw new CodeError(`Unknown name '${e.name}'`, e.pos);
      }
      case 'member': {
        this.periph(e.base, e.pos);
        try {
          return { v: this.chip.read(e.base, e.field), u: true };
        } catch (err) {
          throw new CodeError((err as Error).message, e.pos);
        }
      }
      case 'cast': {
        const a = this.eval(e.arg);
        const r = narrow(e.type, a.v);
        this.record(e, { k: 'cast', type: e.type, a: this.operand(e.arg, a), r, text: printExpr(e), notes: [] });
        return r;
      }
      case 'cond': {
        const t = this.eval(e.test);
        const branch = t.v !== 0 ? e.then : e.else;
        const r = this.eval(branch);
        this.record(e, { k: 'cond', test: this.operand(e.test, t), chosen: this.operand(branch, r), r, text: printExpr(e), notes: [] });
        return r;
      }
      case 'unary': {
        const a = this.eval(e.arg);
        let r: Val;
        switch (e.op) {
          case '~': r = { v: ~a.v >>> 0, u: a.u }; break;
          case '!': r = { v: a.v === 0 ? 1 : 0, u: false }; break;
          case '-': r = { v: -a.v >>> 0, u: a.u }; break;
          default: r = a;
        }
        this.record(e, { k: 'unary', op: e.op, a: this.operand(e.arg, a), r, text: printExpr(e), notes: [] });
        return r;
      }
      case 'binary': {
        if (e.op === '&&' || e.op === '||') {
          const l = this.eval(e.l);
          const lt = l.v !== 0;
          const a = this.operand(e.l, l);
          if ((e.op === '&&' && !lt) || (e.op === '||' && lt)) {
            const r = { v: lt ? 1 : 0, u: false };
            this.record(e, { k: 'logic', op: e.op, a, r, text: printExpr(e), notes: [] });
            return r;
          }
          const rv = this.eval(e.r);
          const r = { v: rv.v !== 0 ? 1 : 0, u: false };
          this.record(e, { k: 'logic', op: e.op, a, b: this.operand(e.r, rv), r, text: printExpr(e), notes: [] });
          return r;
        }
        const a = this.eval(e.l);
        const b = this.eval(e.r);
        const m = this.mark();
        const r = this.binop(e.op, a, b, e.pos, e);
        this.record(e, { k: 'binary', op: e.op, a: this.operand(e.l, a), b: this.operand(e.r, b), r, text: printExpr(e), notes: this.since(m) });
        return r;
      }
    }
  }

  private binop(op: string, a: Val, b: Val, pos: number, e?: Expr): Val {
    if (op === '<<' || op === '>>') {
      const n = b.u ? b.v : toSigned(b.v);
      if (n < 0 || n >= 32) {
        throw new CodeError(`Shifting by ${n} is undefined behaviour in C — the count must be 0..31`, pos);
      }
      if (op === '>>') {
        return { v: a.u ? a.v >>> n : (toSigned(a.v) >> n) >>> 0, u: a.u };
      }
      if (!a.u) {
        const s = toSigned(a.v);
        if (s < 0) this.note('ub', `Left-shifting a negative int is undefined behaviour. Make the left side unsigned (e.g. 0xFu).`);
        else if (s * 2 ** n > INT_MAX) {
          const hint = e?.k === 'binary' && e.l.k === 'num' ? `${e.l.value}u << ${n}` : `(uint32_t)x << ${n}`;
          this.note('ub', `${s} << ${n} overflows a signed int (bit 31 is the sign bit) — undefined behaviour. Write ${hint}.`);
        }
      }
      return { v: (a.v << n) >>> 0, u: a.u };
    }

    const u = a.u || b.u; // usual arithmetic conversions: unsigned wins
    const x = u ? a.v : toSigned(a.v);
    const y = u ? b.v : toSigned(b.v);
    const bool = (c: boolean): Val => ({ v: c ? 1 : 0, u: false });
    switch (op) {
      case '&': return { v: (a.v & b.v) >>> 0, u };
      case '|': return { v: (a.v | b.v) >>> 0, u };
      case '^': return { v: (a.v ^ b.v) >>> 0, u };
      case '+': return { v: (a.v + b.v) >>> 0, u };
      case '-': return { v: (a.v - b.v) >>> 0, u };
      case '*': return { v: Math.imul(a.v, b.v) >>> 0, u };
      case '/': case '%': {
        if (y === 0) throw new CodeError('Division by zero', pos);
        const q = op === '/' ? Math.trunc(x / y) : x % y;
        return { v: q >>> 0, u };
      }
      case '==': return bool(x === y);
      case '!=': return bool(x !== y);
      case '<': return bool(x < y);
      case '<=': return bool(x <= y);
      case '>': return bool(x > y);
      case '>=': return bool(x >= y);
    }
    throw new CodeError(`Unsupported operator ${op}`, pos);
  }
}

export interface RunResult {
  ok: boolean;
  error?: CodeError;
  interp: Interp;
  value?: Val; // expression mode only
}

export function runProgram(src: string, chip: Chip, vars: Record<string, Var> = {}): RunResult {
  const interp = new Interp(chip, vars);
  try {
    interp.run(parseProgram(src));
    return { ok: true, interp };
  } catch (e) {
    if (e instanceof CodeError) return { ok: false, error: e, interp };
    throw e;
  }
}

export function runExpression(src: string, chip: Chip, vars: Record<string, Var> = {}): RunResult {
  const interp = new Interp(chip, vars);
  try {
    const expr = parseExpression(src);
    const value = interp.eval(expr);
    // A bare literal/macro/register has no operator steps; show it as one value step.
    if (!interp.trace.length) {
      const text = printExpr(expr);
      const from = expr.k === 'num' ? 'literal' : expr.k === 'member' ? 'reg' : interp.vars.has(text) ? 'var' : 'macro';
      interp.trace.push({ k: 'value', a: { text, val: value, from }, text, notes: [] });
    }
    return { ok: true, interp, value };
  } catch (e) {
    if (e instanceof CodeError) return { ok: false, error: e, interp };
    throw e;
  }
}
