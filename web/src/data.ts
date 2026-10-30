// Reading the otprof-live/1 data format (docs/DATA_FORMAT.md): index, cycle metadata and the binary arrays, and the
// climatology (otprof-live-clim/1).

export interface VarMeta {
  long_name?: string;
  units?: string;
  dims: string[];
  dtype: "uint16" | "float32";
  scale?: number;
  offset?: number;
  fill?: number;
  valid_range?: [number, number];
  display_range?: [number, number];
  display_range_z?: [number, number][];
  files?: string[];
  file?: string;
  // Climatology only
  stats?: string[]; // statistics, in the order of the files (dimension "stat")
  display_ranges?: Record<string, [number, number]>; // per statistic
  display_ranges_z?: Record<string, [number, number][]>;
  diurnal?: { dims: string[]; stats: string[]; file: string }; // [month][hour][stat][lat][lon]
}

interface GridMeta {
  lat: number[];
  lon: number[];
  z_agl?: number[];
  info?: Record<string, string>;
  notes?: string;
  variables: Record<string, VarMeta>;
}

export interface CycleMeta extends GridMeta {
  format: string;
  cycle: string;
  lead_hours: number[];
}

export interface ClimMeta extends GridMeta {
  format: string;
  months: number[]; // 1 to 12
  hours: number[]; // of the diurnal cycle [UTC]
  years: number[][]; // years in the sample, per month
  stats: string[]; // all statistics, in the order offered
}

export interface Index {
  format: string;
  cycles: string[];
  latest?: string;
  climatology?: string; // directory of the climatology
}

const FORMAT = "otprof-live/1";
const CLIM_FORMAT = "otprof-live-clim/1";
const N_PARALLEL = 4;

async function fetchJson<T>(url: string): Promise<T> {
  const r = await fetch(url, { cache: "no-cache" });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.json() as Promise<T>;
}

export async function loadIndex(dataUrl: string): Promise<Index> {
  const index = await fetchJson<Index>(new URL("index.json", dataUrl).href);
  if (index.format !== FORMAT) console.warn(`index.json: format ${index.format}, expected ${FORMAT}`);
  if (!index.cycles?.length) throw new Error("index.json lists no cycles");
  return index;
}

function decode(buffer: ArrayBuffer, v: VarMeta): Float32Array {
  const scale = v.scale ?? 1;
  const offset = v.offset ?? 0;
  if (v.dtype === "float32") {
    const raw = new Float32Array(buffer);
    return scale === 1 && offset === 0 ? raw : raw.map((x) => offset + scale * x);
  }
  const raw = new Uint16Array(buffer);
  const out = new Float32Array(raw.length);
  for (let k = 0; k < raw.length; k++) out[k] = raw[k] === v.fill ? NaN : offset + scale * raw[k];
  return out;
}

/**
 * Gridded data with a time axis ("steps": the lead times of a cycle, the months of the climatology). Variables with
 * heights are stored one file per step and loaded lazily; the others in one file. Climatology variables have a
 * statistic dimension before the height (per step) or after the step (one file); the accessors take the statistic.
 */
export abstract class Dataset {
  readonly id: string;
  readonly base: string;
  readonly times: Date[];
  readonly lat: number[];
  readonly lon: number[];
  readonly nlat: number;
  readonly nlon: number;
  readonly nz: number;
  readonly z: number[];
  readonly variables: Record<string, VarMeta>;
  readonly info: Record<string, string>;
  readonly notes?: string;
  readonly profileVars: string[];
  readonly columnVars: string[];
  /** 1 where a cell has data at any step (cells outside the domain cannot be selected) */
  valid = new Uint8Array(0);
  protected perStep = new Map<string, (Float32Array | undefined)[]>();
  protected whole = new Map<string, Float32Array>();
  private pending = new Map<number, Promise<void>>();
  private listeners: ((step: number) => void)[] = [];

  protected constructor(id: string, base: string, meta: GridMeta, times: Date[]) {
    this.id = id;
    this.base = base;
    this.times = times;
    this.lat = meta.lat;
    this.lon = meta.lon;
    this.nlat = meta.lat.length;
    this.nlon = meta.lon.length;
    this.z = meta.z_agl ?? [];
    this.nz = this.z.length;
    this.variables = meta.variables;
    this.info = meta.info ?? {};
    this.notes = meta.notes;
    const names = Object.keys(meta.variables);
    this.profileVars = names.filter((n) => meta.variables[n].dims.includes("z"));
    this.columnVars = names.filter((n) => !meta.variables[n].dims.includes("z"));
  }

  /** Variables stored in one file (all steps); the others are split per step. */
  protected async loadWhole() {
    const n = this.nlat * this.nlon;
    this.valid = new Uint8Array(n);
    await Promise.all(
      Object.entries(this.variables).map(async ([name, v]) => {
        if (v.file) {
          const arr = decode(await this.fetchBin(v.file), v);
          this.whole.set(name, arr);
          for (let k = 0; k < arr.length; k++) if (!Number.isNaN(arr[k])) this.valid[k % n] = 1;
        } else this.perStep.set(name, new Array(this.times.length));
      }),
    );
  }

  protected async fetchBin(file: string): Promise<ArrayBuffer> {
    const r = await fetch(new URL(file, this.base).href);
    if (!r.ok) throw new Error(`${this.id}/${file}: HTTP ${r.status}`);
    return r.arrayBuffer();
  }

  hasStep(step: number): boolean {
    return [...this.perStep.values()].every((a) => a[step] !== undefined);
  }

  loadStep(step: number): Promise<void> {
    if (this.hasStep(step)) return Promise.resolve();
    let p = this.pending.get(step);
    if (!p) {
      p = Promise.all(
        [...this.perStep.entries()].map(async ([name, arrs]) => {
          const v = this.variables[name];
          arrs[step] = decode(await this.fetchBin(v.files![step]), v);
          if (this.whole.size === 0) this.markValid(arrs[step]!);
        }),
      ).then(() => {
        this.pending.delete(step);
        this.listeners.forEach((f) => f(step));
      });
      this.pending.set(step, p);
    }
    return p;
  }

  /** Without column variables, the domain comes from the profiles. */
  private markValid(arr: Float32Array) {
    const n = this.nlat * this.nlon;
    for (let k = 0; k < arr.length; k++) if (!Number.isNaN(arr[k])) this.valid[k % n] = 1;
  }

  /** All steps, starting at `first` and wrapping around. */
  async loadAll(first: number) {
    const n = this.times.length;
    const order = Array.from({ length: n }, (_, k) => (first + k) % n);
    const worker = async () => {
      for (let step = order.shift(); step !== undefined; step = order.shift()) await this.loadStep(step);
    };
    await Promise.all(Array.from({ length: N_PARALLEL }, worker));
  }

  onStep(f: (step: number) => void) {
    this.listeners.push(f);
  }

  get loadedCount(): number {
    return this.times.reduce((c, _, step) => c + (this.hasStep(step) ? 1 : 0), 0);
  }

  /** Index of the statistic `stat` of a variable (0 without statistics or if it has not got `stat`) and their number. */
  protected statIndex(name: string, stat?: string): [number, number] {
    const stats = this.variables[name]?.stats;
    if (!stats) return [0, 1];
    return [Math.max(0, stat ? stats.indexOf(stat) : 0), stats.length];
  }

  /** Map field (lat, lon) of a variable at a step (and height index for profile variables), or undefined. */
  field(name: string, step: number, zi: number, stat?: string): Float32Array | undefined {
    const n = this.nlat * this.nlon;
    const [k, ns] = this.statIndex(name, stat);
    const whole = this.whole.get(name);
    if (whole) return whole.subarray((step * ns + k) * n, (step * ns + k + 1) * n);
    return this.perStep.get(name)?.[step]?.subarray((k * this.nz + zi) * n, (k * this.nz + zi + 1) * n);
  }

  /** Profile (z) at a step and cell, or undefined if not loaded. */
  profile(name: string, step: number, cell: number, stat?: string): Float32Array | undefined {
    const arr = this.perStep.get(name)?.[step];
    if (!arr) return undefined;
    const n = this.nlat * this.nlon;
    const off = this.statIndex(name, stat)[0] * this.nz * n + cell;
    return Float32Array.from({ length: this.nz }, (_, zi) => arr[off + zi * n]);
  }

  /** Column variable over all steps at a cell. */
  series(name: string, cell: number, stat?: string): Float32Array {
    const n = this.nlat * this.nlon;
    const [k, ns] = this.statIndex(name, stat);
    const whole = this.whole.get(name)!;
    return Float32Array.from({ length: this.times.length }, (_, step) => whole[(step * ns + k) * n + cell]);
  }

  value(name: string, step: number, zi: number, cell: number, stat?: string): number {
    return this.field(name, step, zi, stat)?.[cell] ?? NaN;
  }

  /** Lowest and highest value per height over the loaded steps at a cell. */
  envelope(name: string, cell: number): [Float32Array, Float32Array] {
    const lo = new Float32Array(this.nz).fill(Infinity);
    const hi = new Float32Array(this.nz).fill(-Infinity);
    for (let step = 0; step < this.times.length; step++) {
      const p = this.profile(name, step, cell);
      if (p) for (let k = 0; k < this.nz; k++) if (!Number.isNaN(p[k])) [lo[k], hi[k]] = [Math.min(lo[k], p[k]), Math.max(hi[k], p[k])]; // fmt: skip
    }
    return [lo, hi];
  }

  /** Index of the cell nearest to (lat, lon) that has data, or -1. */
  nearestCell(lat: number, lon: number): number {
    let best = -1;
    let dBest = Infinity;
    const cosLat = Math.cos((lat * Math.PI) / 180);
    for (let i = 0; i < this.nlat; i++)
      for (let j = 0; j < this.nlon; j++) {
        const cell = i * this.nlon + j;
        if (!this.valid[cell]) continue;
        const d = (this.lat[i] - lat) ** 2 + ((this.lon[j] - lon) * cosLat) ** 2;
        if (d < dBest) [best, dBest] = [cell, d];
      }
    return best;
  }
}

/** One forecast cycle: the steps are the lead times. */
export class Cycle extends Dataset {
  readonly meta: CycleMeta;

  private constructor(id: string, meta: CycleMeta, base: string) {
    const t0 = Date.parse(meta.cycle);
    super(id, base, meta, meta.lead_hours.map((h) => new Date(t0 + h * 3.6e6)));
    this.meta = meta;
  }

  static async open(dataUrl: string, id: string): Promise<Cycle> {
    const base = new URL(`${id}/`, dataUrl).href;
    const meta = await fetchJson<CycleMeta>(new URL("meta.json", base).href);
    if (meta.format !== FORMAT) console.warn(`${id}/meta.json: format ${meta.format}, expected ${FORMAT}`);
    const cycle = new Cycle(id, meta, base);
    await cycle.loadWhole();
    return cycle;
  }
}

/** Statistics per calendar month: the steps are the months (as mid-month dates of the year 2001). */
export class Climatology extends Dataset {
  readonly meta: ClimMeta;
  private diurnalArr = new Map<string, Float32Array>();

  private constructor(meta: ClimMeta, base: string) {
    const mid = (m: number) => new Date((Date.UTC(2001, m - 1, 1) + Date.UTC(2001, m, 1)) / 2);
    super("climatology", base, meta, meta.months.map(mid));
    this.meta = meta;
  }

  static async open(url: string): Promise<Climatology> {
    const base = url.endsWith("/") ? url : `${url}/`;
    const meta = await fetchJson<ClimMeta>(new URL("meta.json", base).href);
    if (meta.format !== CLIM_FORMAT) console.warn(`climatology/meta.json: format ${meta.format}, expected ${CLIM_FORMAT}`); // fmt: skip
    const clim = new Climatology(meta, base);
    await clim.loadWhole();
    return clim;
  }

  protected override async loadWhole() {
    await super.loadWhole();
    await Promise.all(
      Object.entries(this.variables).map(async ([name, v]) => {
        if (v.diurnal) this.diurnalArr.set(name, decode(await this.fetchBin(v.diurnal.file), v));
      }),
    );
  }

  /** Variables with a diurnal cycle. */
  get diurnalVars(): string[] {
    return [...this.diurnalArr.keys()];
  }

  /** Diurnal cycle at a month and cell: per statistic, the values at `meta.hours`. */
  diurnal(name: string, step: number, cell: number): Record<string, Float32Array> | undefined {
    const arr = this.diurnalArr.get(name);
    const stats = this.variables[name].diurnal?.stats;
    if (!arr || !stats) return undefined;
    const n = this.nlat * this.nlon;
    const nh = this.meta.hours.length;
    const at = (h: number, k: number) => arr[((step * nh + h) * stats.length + k) * n + cell];
    return Object.fromEntries(stats.map((s, k) => [s, Float32Array.from({ length: nh }, (_, h) => at(h, k))]));
  }

  /** Statistics a variable has. */
  stats(name: string): string[] {
    return this.variables[name]?.stats ?? [];
  }
}

/** Index of the value in the increasing `values` nearest to `x`. */
export function nearestIndex(values: ArrayLike<number>, x: number): number {
  let best = 0;
  for (let k = 1; k < values.length; k++) if (Math.abs(values[k] - x) < Math.abs(values[best] - x)) best = k;
  return best;
}

/** Cell edges from increasing centres: midpoints, extrapolated by half a cell at both ends. */
export function edges(c: number[]): number[] {
  if (c.length === 1) return [c[0] - 0.5, c[0] + 0.5];
  const mid = c.slice(1).map((v, k) => (v + c[k]) / 2);
  return [c[0] - (mid[0] - c[0]), ...mid, c.at(-1)! + (c.at(-1)! - mid.at(-1)!)];
}

/** Index k with e[k] <= x < e[k+1] in the increasing edges `e`, or -1 outside. */
export function bin(e: number[], x: number): number {
  if (!(x >= e[0] && x < e[e.length - 1])) return -1;
  let lo = 0;
  let hi = e.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (e[mid] <= x) lo = mid;
    else hi = mid;
  }
  return lo;
}
