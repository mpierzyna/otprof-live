// Reading the otprof-live/1 data format (docs/DATA_FORMAT.md): index, cycle metadata and the binary arrays.

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
}

export interface CycleMeta {
  format: string;
  cycle: string;
  lead_hours: number[];
  lat: number[];
  lon: number[];
  z_agl?: number[];
  info?: Record<string, string>;
  notes?: string;
  variables: Record<string, VarMeta>;
}

export interface Index {
  format: string;
  cycles: string[];
  latest?: string;
}

const FORMAT = "otprof-live/1";
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

/** One forecast cycle: metadata and the arrays, loaded lazily per lead time for variables with heights. */
export class Cycle {
  readonly id: string;
  readonly meta: CycleMeta;
  readonly base: string;
  readonly times: Date[];
  readonly nlat: number;
  readonly nlon: number;
  readonly nz: number;
  readonly z: number[];
  readonly profileVars: string[];
  readonly columnVars: string[];
  /** 1 where a cell has data at any lead time (cells outside the domain cannot be selected) */
  valid = new Uint8Array(0);
  private perLead = new Map<string, (Float32Array | undefined)[]>();
  private whole = new Map<string, Float32Array>();
  private pending = new Map<number, Promise<void>>();
  private listeners: ((lead: number) => void)[] = [];

  private constructor(id: string, meta: CycleMeta, base: string) {
    this.id = id;
    this.meta = meta;
    this.base = base;
    const t0 = Date.parse(meta.cycle);
    this.times = meta.lead_hours.map((h) => new Date(t0 + h * 3.6e6));
    this.nlat = meta.lat.length;
    this.nlon = meta.lon.length;
    this.z = meta.z_agl ?? [];
    this.nz = this.z.length;
    const names = Object.keys(meta.variables);
    this.profileVars = names.filter((n) => meta.variables[n].dims.includes("z"));
    this.columnVars = names.filter((n) => !meta.variables[n].dims.includes("z"));
  }

  static async open(dataUrl: string, id: string): Promise<Cycle> {
    const base = new URL(`${id}/`, dataUrl).href;
    const meta = await fetchJson<CycleMeta>(new URL("meta.json", base).href);
    if (meta.format !== FORMAT) console.warn(`${id}/meta.json: format ${meta.format}, expected ${FORMAT}`);
    const cycle = new Cycle(id, meta, base);
    await cycle.loadWhole();
    return cycle;
  }

  /** Variables stored in one file (all lead times); the others are split per lead time. */
  private async loadWhole() {
    const n = this.nlat * this.nlon;
    this.valid = new Uint8Array(n);
    await Promise.all(
      Object.entries(this.meta.variables).map(async ([name, v]) => {
        if (v.file) {
          const arr = decode(await this.fetchBin(v.file), v);
          this.whole.set(name, arr);
          for (let k = 0; k < arr.length; k++) if (!Number.isNaN(arr[k])) this.valid[k % n] = 1;
        } else this.perLead.set(name, new Array(this.times.length));
      }),
    );
  }

  private async fetchBin(file: string): Promise<ArrayBuffer> {
    const r = await fetch(new URL(file, this.base).href);
    if (!r.ok) throw new Error(`${this.id}/${file}: HTTP ${r.status}`);
    return r.arrayBuffer();
  }

  hasLead(lead: number): boolean {
    return [...this.perLead.values()].every((a) => a[lead] !== undefined);
  }

  loadLead(lead: number): Promise<void> {
    if (this.hasLead(lead)) return Promise.resolve();
    let p = this.pending.get(lead);
    if (!p) {
      p = Promise.all(
        [...this.perLead.entries()].map(async ([name, arrs]) => {
          const v = this.meta.variables[name];
          arrs[lead] = decode(await this.fetchBin(v.files![lead]), v);
          if (this.whole.size === 0) this.markValid(arrs[lead]!);
        }),
      ).then(() => {
        this.pending.delete(lead);
        this.listeners.forEach((f) => f(lead));
      });
      this.pending.set(lead, p);
    }
    return p;
  }

  /** Without column variables, the domain comes from the profiles. */
  private markValid(arr: Float32Array) {
    const n = this.nlat * this.nlon;
    for (let k = 0; k < arr.length; k++) if (!Number.isNaN(arr[k])) this.valid[k % n] = 1;
  }

  /** All lead times, starting at `first` and wrapping around. */
  async loadAll(first: number) {
    const n = this.times.length;
    const order = Array.from({ length: n }, (_, k) => (first + k) % n);
    const worker = async () => {
      for (let lead = order.shift(); lead !== undefined; lead = order.shift()) await this.loadLead(lead);
    };
    await Promise.all(Array.from({ length: N_PARALLEL }, worker));
  }

  onLead(f: (lead: number) => void) {
    this.listeners.push(f);
  }

  get loadedCount(): number {
    return this.times.reduce((c, _, lead) => c + (this.hasLead(lead) ? 1 : 0), 0);
  }

  /** Map field (lat, lon) of a variable at a lead time (and height index for profile variables), or undefined. */
  field(name: string, lead: number, zi: number): Float32Array | undefined {
    const n = this.nlat * this.nlon;
    const whole = this.whole.get(name);
    if (whole) return whole.subarray(lead * n, (lead + 1) * n);
    return this.perLead.get(name)?.[lead]?.subarray(zi * n, (zi + 1) * n);
  }

  /** Profile (z) at a lead time and cell, or undefined if not loaded. */
  profile(name: string, lead: number, cell: number): Float32Array | undefined {
    const arr = this.perLead.get(name)?.[lead];
    if (!arr) return undefined;
    const n = this.nlat * this.nlon;
    return Float32Array.from({ length: this.nz }, (_, zi) => arr[zi * n + cell]);
  }

  /** Column variable over all lead times at a cell. */
  series(name: string, cell: number): Float32Array {
    const n = this.nlat * this.nlon;
    const whole = this.whole.get(name)!;
    return Float32Array.from({ length: this.times.length }, (_, lead) => whole[lead * n + cell]);
  }

  value(name: string, lead: number, zi: number, cell: number): number {
    return this.field(name, lead, zi)?.[cell] ?? NaN;
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
        const d = (this.meta.lat[i] - lat) ** 2 + ((this.meta.lon[j] - lon) * cosLat) ** 2;
        if (d < dBest) [best, dBest] = [cell, d];
      }
    return best;
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
