// Runs a program live in the browser: Delay_*() really waits, and `while (1)` keeps
// going until stopped, so the board button can change what the code does.

import { Chip } from './chip';
import { Interp, type Pause } from './interp';
import { CodeError } from './lexer';
import { parseProgram } from './parser';

export interface LiveHooks {
  onFrame: () => void; // throttled redraw while running
  onEnd: (why: 'done' | 'stopped' | 'error', error?: CodeError) => void;
}

const SLICE_MS = 12; // max time on the main thread before letting the browser breathe
const FRAME_MS = 80; // ~12 redraws a second is plenty for LEDs and registers

export class LiveRun {
  readonly interp: Interp;
  passes = 0; // loop passes completed
  delayMs = 0; // total time spent in Delay_*()
  live = false; // true once it paused at least once; a run-once program never does
  running = true;
  private gen: Generator<Pause, void, void>;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private lastFrame = 0;

  // Throws CodeError straight away if the code doesn't parse.
  constructor(
    src: string,
    chip: Chip,
    private hooks: LiveHooks,
  ) {
    const stmts = parseProgram(src);
    this.interp = new Interp(chip);
    this.interp.maxSteps = Infinity;
    this.gen = this.interp.exec(stmts);
  }

  start() {
    this.slice();
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    clearTimeout(this.timer);
    this.hooks.onEnd('stopped');
  }

  private goLive() {
    if (this.live) return;
    this.live = true;
    // A looping program's trace would grow without bound; step-through is for run-once code.
    this.interp.tracing = false;
    this.interp.trace = [];
  }

  private frame(force = false) {
    const now = performance.now();
    if (!force && now - this.lastFrame < FRAME_MS) return;
    this.lastFrame = now;
    this.hooks.onFrame();
  }

  private later(ms: number) {
    this.timer = setTimeout(() => this.slice(), ms);
  }

  private slice() {
    if (!this.running) return;
    const t0 = performance.now();
    try {
      for (;;) {
        const r = this.gen.next();
        if (r.done) {
          this.running = false;
          this.hooks.onEnd('done');
          return;
        }
        if (r.value.k === 'delay') {
          this.goLive();
          this.delayMs += r.value.ms;
          this.frame();
          this.later(r.value.ms);
          return;
        }
        this.passes++;
        if (performance.now() - t0 > SLICE_MS) {
          this.goLive();
          this.frame();
          this.later(0);
          return;
        }
      }
    } catch (e) {
      if (!(e instanceof CodeError)) throw e;
      this.running = false;
      this.hooks.onEnd('error', e);
    }
  }

  // Redraw right now (e.g. after the button was pressed).
  refresh() {
    this.frame(true);
  }
}
