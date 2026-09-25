// Recursive-descent parser for a C subset: declarations, assignments, if/else,
// blocks, Delay_* calls, and full C operator precedence for integer expressions.

import { CodeError, Token, tokenize } from './lexer';

export type CType = 'int' | 'unsigned' | 'uint8_t' | 'uint16_t' | 'uint32_t' | 'int8_t' | 'int16_t' | 'int32_t';

export type Expr =
  | { k: 'num'; value: number; unsigned: boolean; pos: number }
  | { k: 'ident'; name: string; pos: number }
  | { k: 'member'; base: string; field: string; pos: number }
  | { k: 'unary'; op: string; arg: Expr; pos: number }
  | { k: 'binary'; op: string; l: Expr; r: Expr; pos: number }
  | { k: 'cast'; type: CType; arg: Expr; pos: number }
  | { k: 'cond'; test: Expr; then: Expr; else: Expr; pos: number };

export type LValue = Extract<Expr, { k: 'ident' } | { k: 'member' }>;

export type Stmt =
  | { k: 'decl'; type: CType; name: string; init?: Expr; pos: number }
  | { k: 'assign'; target: LValue; op: string; value: Expr; pos: number }
  | { k: 'if'; test: Expr; then: Stmt; else?: Stmt; pos: number }
  | { k: 'block'; body: Stmt[]; pos: number }
  | { k: 'call'; name: string; args: Expr[]; pos: number }
  | { k: 'expr'; expr: Expr; pos: number };

const TYPE_WORDS = new Set(['int', 'unsigned', 'signed', 'uint8_t', 'uint16_t', 'uint32_t', 'int8_t', 'int16_t', 'int32_t', 'volatile', 'const']);

const ASSIGN_OPS = new Set(['=', '|=', '&=', '^=', '<<=', '>>=', '+=', '-=', '*=']);

// Binary operator precedence, loosest first. Same table as C.
const BINARY_LEVELS: string[][] = [
  ['||'],
  ['&&'],
  ['|'],
  ['^'],
  ['&'],
  ['==', '!='],
  ['<', '<=', '>', '>='],
  ['<<', '>>'],
  ['+', '-'],
  ['*', '/', '%'],
];

export const KNOWN_CALLS = new Set(['Delay_Ms', 'Delay_Us']);

class Parser {
  private i = 0;
  constructor(private toks: Token[]) {}

  private peek(o = 0) {
    return this.toks[Math.min(this.i + o, this.toks.length - 1)];
  }
  private next() {
    return this.toks[this.i++];
  }
  private is(text: string, o = 0) {
    const t = this.peek(o);
    return (t.kind === 'punct' || t.kind === 'ident') && t.text === text;
  }
  private expect(text: string, why?: string): Token {
    const t = this.peek();
    if (!this.is(text)) {
      const got = t.kind === 'eof' ? 'end of code' : `'${t.text}'`;
      throw new CodeError(`Expected '${text}' but found ${got}${why ? ` — ${why}` : ''}`, t.pos);
    }
    return this.next();
  }

  program(): Stmt[] {
    const out: Stmt[] = [];
    while (this.peek().kind !== 'eof') out.push(this.statement());
    return out;
  }

  // Parses the whole input as one expression (for "write an expression" levels).
  onlyExpr(): Expr {
    const e = this.expr();
    if (this.is(';')) this.next();
    const t = this.peek();
    if (t.kind !== 'eof') throw new CodeError(`Expected a single expression, found '${t.text}'`, t.pos);
    return e;
  }

  private statement(): Stmt {
    const t = this.peek();
    if (this.is(';')) {
      this.next();
      return { k: 'block', body: [], pos: t.pos };
    }
    if (this.is('{')) {
      this.next();
      const body: Stmt[] = [];
      while (!this.is('}')) {
        if (this.peek().kind === 'eof') throw new CodeError("Missing '}'", t.pos);
        body.push(this.statement());
      }
      this.next();
      return { k: 'block', body, pos: t.pos };
    }
    if (this.is('if')) {
      this.next();
      this.expect('(');
      const test = this.expr();
      this.expect(')');
      const then = this.statement();
      let els: Stmt | undefined;
      if (this.is('else')) {
        this.next();
        els = this.statement();
      }
      return { k: 'if', test, then, else: els, pos: t.pos };
    }
    if (this.is('while') || this.is('for') || this.is('do')) {
      throw new CodeError(`Loops aren't simulated here — write the statements that run once`, t.pos);
    }
    if (t.kind === 'ident' && TYPE_WORDS.has(t.text)) return this.declaration();

    if (t.kind === 'ident' && this.is('(', 1)) {
      const name = this.next().text;
      this.next();
      const args: Expr[] = [];
      if (!this.is(')')) {
        do args.push(this.expr());
        while (this.is(',') && this.next());
      }
      this.expect(')');
      this.expect(';', 'every C statement ends with a semicolon');
      if (!KNOWN_CALLS.has(name)) throw new CodeError(`Unknown function '${name}' — this dojo is about raw registers, no helpers`, t.pos);
      return { k: 'call', name, args, pos: t.pos };
    }

    const lhs = this.unary();
    if (this.is('++') || this.is('--')) {
      const op = this.next().text;
      this.expect(';', 'every C statement ends with a semicolon');
      return { k: 'assign', target: this.lvalue(lhs), op: op === '++' ? '+=' : '-=', value: { k: 'num', value: 1, unsigned: false, pos: t.pos }, pos: t.pos };
    }
    const opTok = this.peek();
    if (opTok.kind === 'punct' && ASSIGN_OPS.has(opTok.text)) {
      this.next();
      const value = this.expr();
      this.expect(';', 'every C statement ends with a semicolon');
      return { k: 'assign', target: this.lvalue(lhs), op: opTok.text, value, pos: t.pos };
    }
    // Not an assignment: re-parse as a full expression statement (has no effect in C).
    this.i = this.toks.indexOf(t);
    const expr = this.expr();
    this.expect(';', 'every C statement ends with a semicolon');
    return { k: 'expr', expr, pos: t.pos };
  }

  private lvalue(e: Expr): LValue {
    if (e.k === 'ident' || e.k === 'member') return e;
    throw new CodeError('Left side of = must be a variable or a register like GPIOC->OUTDR', e.pos);
  }

  private typeName(): CType {
    const start = this.peek();
    const words: string[] = [];
    while (this.peek().kind === 'ident' && TYPE_WORDS.has(this.peek().text)) words.push(this.next().text);
    const core = words.filter((w) => w !== 'volatile' && w !== 'const');
    const joined = core.join(' ');
    const map: Record<string, CType> = {
      int: 'int', 'signed int': 'int', signed: 'int',
      unsigned: 'unsigned', 'unsigned int': 'unsigned',
      uint8_t: 'uint8_t', uint16_t: 'uint16_t', uint32_t: 'uint32_t',
      int8_t: 'int8_t', int16_t: 'int16_t', int32_t: 'int32_t',
    };
    const ty = map[joined];
    if (!ty) throw new CodeError(`Unsupported type '${joined || words.join(' ')}'`, start.pos);
    return ty;
  }

  private declaration(): Stmt {
    const pos = this.peek().pos;
    const type = this.typeName();
    const nameTok = this.next();
    if (nameTok.kind !== 'ident') throw new CodeError('Expected a variable name', nameTok.pos);
    let init: Expr | undefined;
    if (this.is('=')) {
      this.next();
      init = this.expr();
    }
    this.expect(';', 'every C statement ends with a semicolon');
    return { k: 'decl', type, name: nameTok.text, init, pos };
  }

  expr(): Expr {
    const test = this.binary(0);
    if (!this.is('?')) return test;
    const pos = this.next().pos;
    const then = this.expr();
    this.expect(':');
    const els = this.expr();
    return { k: 'cond', test, then, else: els, pos };
  }

  private binary(level: number): Expr {
    if (level >= BINARY_LEVELS.length) return this.unary();
    let l = this.binary(level + 1);
    for (;;) {
      const t = this.peek();
      if (t.kind !== 'punct' || !BINARY_LEVELS[level].includes(t.text)) return l;
      this.next();
      const r = this.binary(level + 1);
      l = { k: 'binary', op: t.text, l, r, pos: t.pos };
    }
  }

  private unary(): Expr {
    const t = this.peek();
    if (t.kind === 'punct' && ['~', '!', '-', '+'].includes(t.text)) {
      this.next();
      return { k: 'unary', op: t.text, arg: this.unary(), pos: t.pos };
    }
    if (t.kind === 'punct' && (t.text === '++' || t.text === '--')) {
      throw new CodeError(`Prefix ${t.text} isn't supported — write x ${t.text[0]}= 1;`, t.pos);
    }
    if (this.is('(') && this.peek(1).kind === 'ident' && TYPE_WORDS.has(this.peek(1).text)) {
      this.next();
      const type = this.typeName();
      this.expect(')');
      return { k: 'cast', type, arg: this.unary(), pos: t.pos };
    }
    return this.postfix();
  }

  private postfix(): Expr {
    const t = this.next();
    if (t.kind === 'num') return { k: 'num', value: t.value!, unsigned: !!t.unsigned, pos: t.pos };
    if (t.kind === 'punct' && t.text === '(') {
      const e = this.expr();
      this.expect(')', 'unbalanced parentheses');
      return e;
    }
    if (t.kind === 'ident') {
      if (this.is('->')) {
        this.next();
        const f = this.next();
        if (f.kind !== 'ident') throw new CodeError(`Expected a register name after ${t.text}->`, f.pos);
        return { k: 'member', base: t.text, field: f.text, pos: t.pos };
      }
      if (this.is('(')) throw new CodeError(`Function calls like ${t.text}() aren't allowed inside expressions`, t.pos);
      return { k: 'ident', name: t.text, pos: t.pos };
    }
    if (t.kind === 'eof') throw new CodeError('Code ends in the middle of an expression', t.pos);
    throw new CodeError(`Unexpected '${t.text}'`, t.pos);
  }
}

export function parseProgram(src: string): Stmt[] {
  return new Parser(tokenize(src)).program();
}

export function parseExpression(src: string): Expr {
  return new Parser(tokenize(src)).onlyExpr();
}
