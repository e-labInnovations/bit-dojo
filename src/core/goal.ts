// Works out "what the player needs to produce" from a level's own checks, so every
// level gets a target picture without hand-written diagrams.
//
// Each level's expect() is evaluated over many starting states. For every checked bit
// we ask: is it always kept? always 1? always 0? always flipped? always equal to some
// other input bit? That classification is the goal.

import { Chip, snapshot } from './chip';
import type { Before, Level } from './levels';
import { buildState, rng, type Case } from './runner';

export type BitGoal =
  | { k: 'keep' }
  | { k: 'set' }
  | { k: 'clear' }
  | { k: 'flip' }
  | { k: 'any' }
  | { k: 'copy'; from: string; bit: number; invert: boolean }
  | { k: 'vary' };

export interface TargetGoal {
  key: string; // register key or "var:name"
  bits: BitGoal[]; // index = bit number
}

export interface LevelGoal {
  targets: TargetGoal[];
  exprValue?: number; // expression levels with one fixed answer
  truthy?: { key: string; bit: number; invert: boolean }; // true/false levels: the bit that decides
  extras: { label: string; why: string }[];
}

const SEEDS = 8;

export function beforeOf(level: Level, c: Case): Before {
  const state = buildState(c);
  const regs = snapshot(new Chip(state));
  const vars: Record<string, number> = {};
  for (const name of Object.keys(level.vars ?? {})) vars[name] = c.vars?.[name] ?? 0;
  return { regs, vars, state };
}

const read = (b: Before, key: string) => (key.startsWith('var:') ? b.vars[key.slice(4)] : b.regs[key]) >>> 0;
const bit = (v: number, i: number) => (v >>> i) & 1;

// Every input a copied bit could come from.
function sources(level: Level, b: Before): string[] {
  return [...new Set([...level.show, ...Object.keys(b.vars).map((v) => 'var:' + v)])];
}

export function deriveGoal(level: Level): LevelGoal {
  const befores: Before[] = [];
  for (let s = 0; s < SEEDS; s++) for (const c of level.cases(rng(level.seed + s * 7919))) befores.push(beforeOf(level, c));

  const goal: LevelGoal = { targets: [], extras: [] };

  if (level.kind === 'expr' && level.expectValue) {
    const wants = befores.map((b) => level.expectValue!(b) >>> 0);
    if (level.truthy) {
      const truth = wants.map((w) => (w !== 0 ? 1 : 0));
      outer: for (const key of level.show) {
        for (let i = 0; i < 32; i++) {
          for (const invert of [false, true]) {
            if (befores.every((b, n) => (bit(read(b, key), i) ^ (invert ? 1 : 0)) === truth[n])) {
              goal.truthy = { key, bit: i, invert };
              break outer;
            }
          }
        }
      }
    } else if (wants.every((w) => w === wants[0])) {
      goal.exprValue = wants[0];
    }
  }

  if (!level.expect) return goal;

  // Collect (before, expected value, mask) per checked key.
  const perKey = new Map<string, { b: Before; want: number; mask: number }[]>();
  for (const b of befores) {
    for (const chk of level.expect(b)) {
      if ('ok' in chk) {
        if (!goal.extras.some((e) => e.label === chk.label)) goal.extras.push({ label: chk.label, why: chk.why });
        continue;
      }
      const list = perKey.get(chk.key) ?? [];
      list.push({ b, want: chk.value >>> 0, mask: (chk.mask ?? 0xffffffff) >>> 0 });
      perKey.set(chk.key, list);
    }
  }

  for (const [key, rows] of perKey) {
    const bits: BitGoal[] = [];
    for (let i = 0; i < 32; i++) {
      const live = rows.filter((r) => bit(r.mask, i));
      if (!live.length) {
        bits[i] = { k: 'any' };
        continue;
      }
      const e = live.map((r) => bit(r.want, i));
      const p = live.map((r) => bit(read(r.b, key), i));
      if (e.every((x, n) => x === p[n])) bits[i] = { k: 'keep' };
      else if (e.every((x) => x === 1)) bits[i] = { k: 'set' };
      else if (e.every((x) => x === 0)) bits[i] = { k: 'clear' };
      else if (e.every((x, n) => x !== p[n])) bits[i] = { k: 'flip' };
      else bits[i] = findCopy(level, live, e, i) ?? { k: 'vary' };
    }
    goal.targets.push({ key, bits });
  }
  return goal;
}

function findCopy(level: Level, live: { b: Before }[], e: number[], target: number): BitGoal | null {
  // Try the most natural source bits first: same position, then nearest.
  const order = Array.from({ length: 32 }, (_, j) => j).sort((x, y) => Math.abs(x - target) - Math.abs(y - target));
  for (const from of sources(level, live[0].b)) {
    for (const j of order) {
      for (const invert of [false, true]) {
        if (live.every((r, n) => (bit(read(r.b, from), j) ^ (invert ? 1 : 0)) === e[n])) return { k: 'copy', from, bit: j, invert };
      }
    }
  }
  return null;
}
