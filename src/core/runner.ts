// Runs a player's code against every test case of a level and grades the result.

import { Chip, ChipState, External, Note, cloneState, hex, resetState, snapshot } from './chip';
import { CodeError } from './lexer';
import { RunResult, Step, Var, runExpression, runProgram } from './interp';
import type { Level } from './levels';

export interface Case {
  label: string;
  regs?: Record<string, number>;
  external?: Record<string, External>;
  vars?: Record<string, number>;
}

export interface After {
  regs: Record<string, number>;
  vars: Record<string, number>;
  chip: Chip;
  writes: { key: string; value: number }[];
  value?: number; // expression levels
}

export type Check =
  | { key: string; value: number; mask?: number } // key is a register or "var:name"
  | { label: string; ok: (a: After) => boolean; why: string };

export interface CaseResult {
  label: string;
  before: Record<string, number>;
  beforeVars: Record<string, number>;
  beforeState: ChipState;
  after?: After;
  pass: boolean;
  problems: string[];
  notes: Note[];
  steps: Step[]; // trace for the step-by-step visualizer
  error?: CodeError;
}

// Deterministic PRNG so a level's random cases are the same on every run.
export function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export type Rng = ReturnType<typeof rng>;

export function buildState(c: Case): ChipState {
  const s = resetState();
  Object.assign(s.regs, c.regs ?? {});
  Object.assign(s.external, c.external ?? {});
  return s;
}

function readKey(key: string, a: After): number {
  return key.startsWith('var:') ? a.vars[key.slice(4)] : a.regs[key];
}

function diffBits(x: number) {
  const bits: number[] = [];
  for (let i = 31; i >= 0; i--) if ((x >>> i) & 1) bits.push(i);
  return bits.length > 6 ? `${bits.length} bits` : `bit${bits.length > 1 ? 's' : ''} ${bits.join(', ')}`;
}

export function runCase(level: Level, code: string, c: Case): CaseResult {
  const state = buildState(c);
  const chip = new Chip(state);
  const before = snapshot(chip);
  const vars: Record<string, Var> = {};
  for (const [name, type] of Object.entries(level.vars ?? {})) vars[name] = { type, value: c.vars?.[name] ?? 0 };
  const beforeVars = Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, v.value]));

  const res: RunResult = level.kind === 'expr' ? runExpression(code, chip, vars) : runProgram(code, chip, vars);
  const notes = res.interp.allNotes();
  const base = { label: c.label, before, beforeVars, beforeState: cloneState(state), notes, steps: res.interp.trace };
  if (!res.ok) return { ...base, pass: false, problems: [res.error!.message], error: res.error };

  const after: After = {
    regs: snapshot(chip),
    vars: Object.fromEntries([...res.interp.vars].map(([k, v]) => [k, v.value])),
    chip,
    writes: chip.writes,
    value: res.value?.v,
  };
  const problems: string[] = [];

  if (level.kind === 'expr') {
    const want = level.expectValue!({ regs: before, vars: beforeVars, state });
    const got = after.value!;
    if (level.truthy) {
      if ((got !== 0) !== (want !== 0)) problems.push(`Expression gave ${hex(got)} (${got !== 0 ? 'true' : 'false'}), should be ${want !== 0 ? 'true' : 'false'} here.`);
    } else if (got >>> 0 !== want >>> 0) {
      problems.push(`Expression gave ${hex(got)}, expected ${hex(want)} (differs in ${diffBits((got ^ want) >>> 0)}).`);
    }
  }

  for (const chk of level.expect?.({ regs: before, vars: beforeVars, state }) ?? []) {
    if ('ok' in chk) {
      if (!chk.ok(after)) problems.push(chk.why);
      continue;
    }
    const mask = chk.mask ?? 0xffffffff;
    const got = readKey(chk.key, after) >>> 0;
    const bad = ((got ^ chk.value) & mask) >>> 0;
    if (bad) {
      const name = chk.key.replace('var:', '');
      problems.push(`${name} is ${hex(got)}, expected ${hex((chk.value & mask) | (got & ~mask))} — wrong ${diffBits(bad)}.`);
    }
  }

  if (!level.allowUB) for (const n of notes) if (n.level === 'ub') problems.push(`Undefined behaviour: ${n.msg}`);

  return { ...base, after, pass: problems.length === 0, problems };
}

export function runLevel(level: Level, code: string): CaseResult[] {
  return level.cases(rng(level.seed)).map((c) => runCase(level, code, c));
}
