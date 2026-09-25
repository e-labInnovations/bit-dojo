// A small CH32V003 model: RCC clock enables and the three GPIO ports.
// Values and layouts come from ch32fun's ch32v003hw.h and the CH32V003 reference manual.

export type PortName = 'GPIOA' | 'GPIOC' | 'GPIOD';
export type PeriphName = 'RCC' | PortName;
export type RegKey = `${PeriphName}->${string}`;

export interface Note {
  level: 'ub' | 'warn' | 'info';
  msg: string;
}

export interface FieldDef {
  name: string;
  lsb: number;
  width: number;
}

export interface RegDef {
  periph: PeriphName;
  name: string;
  reset: number;
  writable: number; // bits that exist; writes to others are dropped
  access: 'rw' | 'ro' | 'wo';
  fields: FieldDef[];
  about: string;
}

const PORT_CLOCK_BIT: Record<PortName, number> = { GPIOA: 2, GPIOC: 4, GPIOD: 5 };

const bitFields = (names: [string, number][]): FieldDef[] => names.map(([name, lsb]) => ({ name, lsb, width: 1 }));

const cfglrFields: FieldDef[] = Array.from({ length: 8 }, (_, p) => [
  { name: `MODE${p}`, lsb: p * 4, width: 2 },
  { name: `CNF${p}`, lsb: p * 4 + 2, width: 2 },
]).flat();

const pinFields = (prefix: string, offset = 0): FieldDef[] =>
  Array.from({ length: 8 }, (_, p) => ({ name: `${prefix}${p}`, lsb: p + offset, width: 1 }));

function portRegs(port: PortName): RegDef[] {
  return [
    { periph: port, name: 'CFGLR', reset: 0x44444444, writable: 0xffffffff, access: 'rw', fields: cfglrFields, about: '4 bits per pin: MODE[1:0] (0 = input, 1/2/3 = output speed) and CNF[1:0] (what kind of input/output).' },
    { periph: port, name: 'INDR', reset: 0, writable: 0, access: 'ro', fields: pinFields('IDR'), about: 'Input data: the real level on each pin. Read-only.' },
    { periph: port, name: 'OUTDR', reset: 0, writable: 0xff, access: 'rw', fields: pinFields('ODR'), about: 'Output data. For outputs: the level to drive. For IN_PUPD inputs: 1 = pull-up, 0 = pull-down.' },
    { periph: port, name: 'BSHR', reset: 0, writable: 0x00ff00ff, access: 'wo', fields: [...pinFields('BS'), ...pinFields('BR', 16)], about: 'Write-only. Bits 0-7 set OUTDR bits, bits 16-23 clear them. Zeros do nothing, so no read-modify-write is needed.' },
    { periph: port, name: 'BCR', reset: 0, writable: 0xff, access: 'wo', fields: pinFields('BR'), about: 'Write-only. Writing 1 to bit n clears OUTDR bit n.' },
  ];
}

export const REGS: RegDef[] = [
  {
    periph: 'RCC', name: 'APB2PCENR', reset: 0, writable: 0x5a35, access: 'rw',
    fields: bitFields([['AFIOEN', 0], ['IOPAEN', 2], ['IOPCEN', 4], ['IOPDEN', 5], ['ADC1EN', 9], ['TIM1EN', 11], ['SPI1EN', 12], ['USART1EN', 14]]),
    about: 'APB2 clock enables. A peripheral whose bit is 0 has no clock: writes to it are ignored and reads return 0.',
  },
  {
    periph: 'RCC', name: 'APB1PCENR', reset: 0, writable: 0x10200801, access: 'rw',
    fields: bitFields([['TIM2EN', 0], ['WWDGEN', 11], ['I2C1EN', 21], ['PWREN', 28]]),
    about: 'APB1 clock enables.',
  },
  ...portRegs('GPIOA'),
  ...portRegs('GPIOC'),
  ...portRegs('GPIOD'),
];

export const REG_BY_KEY = new Map<string, RegDef>(REGS.map((r) => [`${r.periph}->${r.name}`, r]));

export const PERIPHS = new Set<string>(['RCC', 'GPIOA', 'GPIOC', 'GPIOD']);

// Macros exactly as ch32fun defines them. `unsigned` = has a (uint32_t) cast in the header.
export const MACROS: Record<string, { value: number; unsigned: boolean; group: string }> = {
  RCC_APB2Periph_AFIO: { value: 0x1, unsigned: true, group: 'RCC' },
  RCC_APB2Periph_GPIOA: { value: 0x4, unsigned: true, group: 'RCC' },
  RCC_APB2Periph_GPIOC: { value: 0x10, unsigned: true, group: 'RCC' },
  RCC_APB2Periph_GPIOD: { value: 0x20, unsigned: true, group: 'RCC' },
  RCC_APB2Periph_ADC1: { value: 0x200, unsigned: true, group: 'RCC' },
  RCC_APB2Periph_TIM1: { value: 0x800, unsigned: true, group: 'RCC' },
  RCC_APB2Periph_SPI1: { value: 0x1000, unsigned: true, group: 'RCC' },
  RCC_APB2Periph_USART1: { value: 0x4000, unsigned: true, group: 'RCC' },
  RCC_APB1Periph_TIM2: { value: 0x1, unsigned: true, group: 'RCC' },
  RCC_APB1Periph_WWDG: { value: 0x800, unsigned: true, group: 'RCC' },
  RCC_APB1Periph_I2C1: { value: 0x200000, unsigned: true, group: 'RCC' },
  RCC_APB1Periph_PWR: { value: 0x10000000, unsigned: true, group: 'RCC' },
  GPIO_Speed_In: { value: 0, unsigned: false, group: 'MODE' },
  GPIO_Speed_10MHz: { value: 1, unsigned: false, group: 'MODE' },
  GPIO_Speed_2MHz: { value: 2, unsigned: false, group: 'MODE' },
  GPIO_Speed_50MHz: { value: 3, unsigned: false, group: 'MODE' },
  GPIO_CNF_IN_ANALOG: { value: 0, unsigned: false, group: 'CNF' },
  GPIO_CNF_IN_FLOATING: { value: 4, unsigned: false, group: 'CNF' },
  GPIO_CNF_IN_PUPD: { value: 8, unsigned: false, group: 'CNF' },
  GPIO_CNF_OUT_PP: { value: 0, unsigned: false, group: 'CNF' },
  GPIO_CNF_OUT_OD: { value: 4, unsigned: false, group: 'CNF' },
  GPIO_CNF_OUT_PP_AF: { value: 8, unsigned: false, group: 'CNF' },
  GPIO_CNF_OUT_OD_AF: { value: 12, unsigned: false, group: 'CNF' },
};

// What the outside world does to a pin. The board has a button on PD2 to GND.
export type External = 'float' | 'low' | 'high';

export type Drive = 'high' | 'low' | 'hiz' | 'pull-up' | 'pull-down' | 'af' | 'off';

export interface ChipState {
  regs: Record<string, number>;
  external: Record<string, External>; // key like "PD2"
}

export function resetState(): ChipState {
  const regs: Record<string, number> = {};
  for (const r of REGS) regs[`${r.periph}->${r.name}`] = r.reset;
  return { regs, external: {} };
}

export function cloneState(s: ChipState): ChipState {
  return { regs: { ...s.regs }, external: { ...s.external } };
}

export const hex = (v: number, digits = 8) => '0x' + (v >>> 0).toString(16).toUpperCase().padStart(digits, '0');

export class Chip {
  state: ChipState;
  notes: Note[] = [];
  writes: { key: string; value: number }[] = [];
  private seen = new Set<string>();

  constructor(state: ChipState) {
    this.state = cloneState(state);
  }

  note(level: Note['level'], msg: string) {
    if (this.seen.has(msg)) return;
    this.seen.add(msg);
    this.notes.push({ level, msg });
  }

  clockOn(port: PortName): boolean {
    return ((this.state.regs['RCC->APB2PCENR'] >>> PORT_CLOCK_BIT[port]) & 1) === 1;
  }

  def(periph: string, name: string): RegDef {
    const d = REG_BY_KEY.get(`${periph}->${name}`);
    if (d) return d;
    if (name === 'CFGHR') throw new Error(`CH32V003 ports only have pins 0-7, so ${periph}->CFGHR does nothing. Use CFGLR.`);
    const names = REGS.filter((r) => r.periph === periph).map((r) => r.name);
    throw new Error(`${periph} has no register '${name}' in this dojo. Try: ${names.join(', ')}`);
  }

  read(periph: string, name: string): number {
    const d = this.def(periph, name);
    const key = `${periph}->${name}`;
    if (d.periph !== 'RCC' && !this.clockOn(d.periph)) {
      this.note('warn', `${d.periph} clock is off (RCC->APB2PCENR bit ${PORT_CLOCK_BIT[d.periph]}), so reading ${key} returns 0.`);
      return 0;
    }
    if (d.access === 'wo') {
      this.note('info', `${key} is write-only — reading it returns 0.`);
      return 0;
    }
    if (name === 'INDR') return this.inputs(d.periph as PortName);
    return this.state.regs[key] >>> 0;
  }

  write(periph: string, name: string, value: number) {
    const d = this.def(periph, name);
    const key = `${periph}->${name}`;
    value >>>= 0;
    this.writes.push({ key, value });
    if (d.periph !== 'RCC' && !this.clockOn(d.periph)) {
      this.note('warn', `${d.periph} clock is off, so the write to ${key} was ignored. Enable it in RCC->APB2PCENR first.`);
      return;
    }
    if (d.access === 'ro') {
      this.note('warn', `${key} is read-only — the write was ignored.`);
      return;
    }
    const dropped = value & ~d.writable;
    if (dropped) this.note('info', `${key}: bits ${hex(dropped)} don't exist in hardware and were dropped.`);
    const v = value & d.writable;
    this.state.regs[key] = v >>> 0;

    const out = `${periph}->OUTDR`;
    if (name === 'BSHR') {
      const set = v & 0xff;
      const clr = (v >>> 16) & 0xff;
      // If both halves hit the same pin, set wins (reference manual).
      this.state.regs[out] = ((this.state.regs[out] & ~clr) | set) >>> 0;
    } else if (name === 'BCR') {
      this.state.regs[out] = (this.state.regs[out] & ~v) >>> 0;
    }
  }

  pinConfig(port: PortName, pin: number) {
    const cfg = (this.state.regs[`${port}->CFGLR`] >>> (pin * 4)) & 0xf;
    return { mode: cfg & 3, cnf: cfg >> 2 };
  }

  drive(port: PortName, pin: number): Drive {
    if (!this.clockOn(port)) return 'off';
    const { mode, cnf } = this.pinConfig(port, pin);
    const out = (this.state.regs[`${port}->OUTDR`] >>> pin) & 1;
    if (mode === 0) {
      if (cnf === 2) return out ? 'pull-up' : 'pull-down';
      return 'hiz';
    }
    if (cnf >= 2) return 'af';
    if (cnf === 1) return out ? 'hiz' : 'low';
    return out ? 'high' : 'low';
  }

  // Level seen by the input buffer of each pin.
  inputs(port: PortName): number {
    let v = 0;
    const letter = port[4];
    for (let p = 0; p < 8; p++) {
      const ext = this.state.external[`P${letter}${p}`] ?? 'float';
      const { mode, cnf } = this.pinConfig(port, p);
      const d = this.drive(port, p);
      let level = 0;
      if (mode === 0 && cnf === 0) level = 0; // analog: digital input disabled
      else if (d === 'high') level = 1;
      else if (d === 'low') level = 0;
      else if (ext !== 'float') level = ext === 'high' ? 1 : 0;
      else if (d === 'pull-up') level = 1;
      else level = 0;
      v |= level << p;
    }
    return v >>> 0;
  }
}

export function snapshot(chip: Chip): Record<string, number> {
  const out = { ...chip.state.regs };
  for (const port of ['GPIOA', 'GPIOC', 'GPIOD'] as PortName[]) out[`${port}->INDR`] = chip.clockOn(port) ? chip.inputs(port) : 0;
  return out;
}
