// Evaluates parsed C against a Chip, with 32-bit int/unsigned semantics as on RV32.
// Flags undefined behaviour (bad shift counts, shifting into the sign bit) as notes.

import { Chip, MACROS, Note, PERIPHS } from './chip';
import { CodeError } from './lexer';
import { CType, Expr, LValue, Stmt, parseExpression, parseProgram } from './parser';

export interface Val {
  v: number; // bit pattern, 0..2^32-1
  u: boolean; // unsigned?
}

export interface Var {
  type: CType;
  value: number;
}

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
  private noteSeen = new Set<string>();
  private steps = 0;

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
        const init = s.init ? this.eval(s.init).v : 0;
        if (!s.init) this.note('warn', `'${s.name}' has no initial value. In real C a local would hold garbage — here it's 0.`);
        this.vars.set(s.name, { type: s.type, value: narrow(s.type, init).v });
        return;
      }
      case 'assign': {
        let value: Val;
        if (s.op === '=') value = this.eval(s.value);
        else value = this.binop(s.op.slice(0, -1), this.readL(s.target), this.eval(s.value), s.pos);
        this.writeL(s.target, value.v);
        return;
      }
    }
  }

  private readL(t: LValue): Val {
    return this.eval(t);
  }

  private writeL(t: LValue, v: number) {
    if (t.k === 'member') {
      this.periph(t.base, t.pos);
      try {
        this.chip.write(t.base, t.field, v);
      } catch (e) {
        throw new CodeError((e as Error).message, t.pos);
      }
      return;
    }
    const cur = this.vars.get(t.name);
    if (!cur) {
      if (MACROS[t.name]) throw new CodeError(`${t.name} is a constant macro — you can't assign to it`, t.pos);
      throw new CodeError(`'${t.name}' isn't declared. Declare it first, e.g. uint32_t ${t.name} = 0;`, t.pos);
    }
    cur.value = narrow(cur.type, v).v;
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
      case 'cast': return narrow(e.type, this.eval(e.arg).v);
      case 'cond': return this.eval(e.test).v !== 0 ? this.eval(e.then) : this.eval(e.else);
      case 'unary': {
        const a = this.eval(e.arg);
        switch (e.op) {
          case '~': return { v: ~a.v >>> 0, u: a.u };
          case '!': return { v: a.v === 0 ? 1 : 0, u: false };
          case '-': return { v: -a.v >>> 0, u: a.u };
          default: return a;
        }
      }
      case 'binary': {
        if (e.op === '&&' || e.op === '||') {
          const l = this.eval(e.l).v !== 0;
          if (e.op === '&&' && !l) return { v: 0, u: false };
          if (e.op === '||' && l) return { v: 1, u: false };
          return { v: this.eval(e.r).v !== 0 ? 1 : 0, u: false };
        }
        return this.binop(e.op, this.eval(e.l), this.eval(e.r), e.pos, e);
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
    const value = interp.eval(parseExpression(src));
    return { ok: true, interp, value };
  } catch (e) {
    if (e instanceof CodeError) return { ok: false, error: e, interp };
    throw e;
  }
}
