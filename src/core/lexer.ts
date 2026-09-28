// Tokenizer for the small C subset the dojo understands.

export type TokenKind = 'num' | 'ident' | 'punct' | 'eof';

export interface Token {
  kind: TokenKind;
  text: string;
  pos: number; // offset into the source, for error messages
  value?: number; // num only: the 32-bit pattern
  unsigned?: boolean; // num only: had a u/U suffix, or needed unsigned to fit
}

export class CodeError extends Error {
  constructor(
    message: string,
    public pos: number,
  ) {
    super(message);
  }
}

// Longest first, so "<<=" wins over "<<" wins over "<".
const PUNCT = [
  '<<=', '>>=',
  '->', '<<', '>>', '<=', '>=', '==', '!=', '&&', '||', '|=', '&=', '^=', '+=', '-=', '*=', '++', '--',
  '(', ')', '{', '}', ';', ',', '~', '!', '+', '-', '*', '/', '%', '<', '>', '&', '^', '|', '=', '?', ':',
];

const INT_MAX = 0x7fffffff;
const UINT_MAX = 0xffffffff;

export function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (src.startsWith('//', i)) {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === '#') {
      const eol = src.indexOf('\n', i);
      const line = src.slice(i, eol < 0 ? src.length : eol);
      if (!/^#\s*include\b/.test(line)) throw new CodeError(`${line.split(/\s/)[0]} isn't supported here — write the value directly (only #include lines are ignored)`, i);
      i = eol < 0 ? src.length : eol;
      continue;
    }
    if (src.startsWith('/*', i)) {
      const end = src.indexOf('*/', i + 2);
      if (end < 0) throw new CodeError('Unclosed /* comment', i);
      i = end + 2;
      continue;
    }
    if (/[0-9]/.test(c)) {
      out.push(readNumber(src, i));
      i += out[out.length - 1].text.length;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i))!;
      out.push({ kind: 'ident', text: m[0], pos: i });
      i += m[0].length;
      continue;
    }
    const p = PUNCT.find((p) => src.startsWith(p, i));
    if (!p) throw new CodeError(`Unexpected character '${c}'`, i);
    out.push({ kind: 'punct', text: p, pos: i });
    i += p.length;
  }
  out.push({ kind: 'eof', text: '', pos: src.length });
  return out;
}

function readNumber(src: string, start: number): Token {
  const m = /^(0[xX][0-9a-fA-F]+|0[bB][01]+|[0-9]+)([uUlL]*)/.exec(src.slice(start));
  if (!m) throw new CodeError('Bad number', start);
  const [text, body, suffix] = m;
  const after = src[start + text.length];
  if (after && /[A-Za-z0-9_]/.test(after)) {
    throw new CodeError(`Bad number '${text}${after}'`, start);
  }

  let big: bigint;
  const isDecimal = !/^0[xXbB]/.test(body);
  if (/^0[bB]/.test(body)) big = BigInt('0b' + body.slice(2));
  else if (/^0[xX]/.test(body)) big = BigInt(body);
  else if (body.length > 1 && body[0] === '0') {
    if (/[89]/.test(body)) throw new CodeError(`'${body}' starts with 0, so C reads it as octal — and 8/9 are not octal digits`, start);
    big = BigInt('0o' + body.slice(1));
  } else big = BigInt(body);

  if (big > BigInt(UINT_MAX)) throw new CodeError(`${text} does not fit in 32 bits`, start);
  const n = Number(big);
  let unsigned = /[uU]/.test(suffix);
  if (!unsigned && n > INT_MAX) {
    // C rule: hex/octal literals that overflow int become unsigned int.
    // Decimal ones would become long long on RV32 — we treat them as unsigned too.
    if (isDecimal) {
      throw new CodeError(`${text} is too big for int. On RV32 C makes it a 64-bit long long — write ${text}u`, start);
    }
    unsigned = true;
  }
  return { kind: 'num', text, pos: start, value: n >>> 0, unsigned };
}
