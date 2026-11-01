// Shared view state of all panels, mirrored in the URL hash: forecast #cycle=..&var=..&t=<lead h>&z=<m>&lat=..&lon=..,
// climatology #mode=clim&var=..&month=<1-12>&stat=..&z=<m>&lat=..&lon=..; log=<names>: the log₁₀ variables shown as
// log₁₀, the others linearly (only if not the defaults; log=0: all linearly, log=1: all as log₁₀)

import { Climatology, type Cycle, type Dataset, nearestIndex } from "./data";

export type Mode = "live" | "clim";

export interface State {
  mode: Mode;
  cycle: string;
  variable: string;
  lead: number; // index into the steps: the cycle's lead times, the climatology's months
  stat: string; // statistic shown in the climatology
  diurnalKind: "box" | "violin"; // plots of the climatology's diurnal cycle
  zi: number; // index into the heights
  cell: number; // lat index * nlon + lon index, -1 for none
  playing: boolean;
  heightScale: "log" | "linear";
  colourPerHeight: boolean;
  logValues: Record<string, boolean>; // per variable stored as log₁₀: shown as log₁₀ (true) or linearly; replaced on change
}

export type Key = keyof State;
type Listener = (s: State, changed: Set<Key>) => void;

export class Store {
  state: State;
  private listeners: Listener[] = [];

  constructor(initial: State) {
    this.state = initial;
  }

  set(patch: Partial<State>) {
    const changed = new Set<Key>();
    for (const [k, v] of Object.entries(patch) as [Key, never][])
      if (this.state[k] !== v) {
        changed.add(k);
        (this.state[k] as unknown) = v;
      }
    if (changed.size) this.listeners.forEach((f) => f(this.state, changed));
  }

  subscribe(f: Listener) {
    this.listeners.push(f);
  }
}

export interface HashState {
  mode?: Mode;
  cycle?: string;
  variable?: string;
  leadHours?: number;
  month?: number; // 1 to 12
  stat?: string;
  z?: number;
  lat?: number;
  lon?: number;
  log?: string; // "0", "1" or the names of the log₁₀ variables shown as log₁₀, comma-separated
}

export function parseHash(hash: string): HashState {
  const p = new URLSearchParams(hash.replace(/^#/, ""));
  const num = (k: string) => (p.has(k) && Number.isFinite(+p.get(k)!) ? +p.get(k)! : undefined);
  return {
    mode: p.get("mode") === "clim" ? "clim" : p.has("mode") || p.has("cycle") ? "live" : undefined,
    cycle: p.get("cycle") ?? undefined,
    variable: p.get("var") ?? undefined,
    leadHours: num("t"),
    month: num("month"),
    stat: p.get("stat") ?? undefined,
    z: num("z"),
    lat: num("lat"),
    lon: num("lon"),
    log: p.get("log") ?? undefined,
  };
}

/** The log₁₀ switches of the variables `names` from the hash value `log` ("0", "1" or the names shown as log₁₀) */
export function parseLog(log: string, names: string[]): Record<string, boolean> {
  const on = log.split(",");
  return Object.fromEntries(names.map((n) => [n, log === "1" || on.includes(n)]));
}

/** The view as URL hash; `logDefault`: the log₁₀ switches at the start (`log` only if they differ) */
export function toHash(s: State, cycle: Dataset, logDefault: Record<string, boolean>): string {
  const p =
    cycle instanceof Climatology
      ? new URLSearchParams({ mode: "clim", var: s.variable, month: String(cycle.meta.months[s.lead]), stat: s.stat })
      : new URLSearchParams({ cycle: s.cycle, var: s.variable, t: String((cycle as Cycle).meta.lead_hours[s.lead]) }); // fmt: skip
  const names = Object.keys(logDefault);
  if (names.some((n) => (s.logValues[n] ?? logDefault[n]) !== logDefault[n]))
    p.set("log", names.filter((n) => s.logValues[n] ?? logDefault[n]).join(","));
  if (cycle.nz) p.set("z", String(Math.round(cycle.z[s.zi])));
  if (s.cell >= 0) {
    p.set("lat", cycle.lat[Math.floor(s.cell / cycle.nlon)].toFixed(2));
    p.set("lon", cycle.lon[s.cell % cycle.nlon].toFixed(2));
  }
  return `#${String(p).replace(/%2C/g, ",")}`; // commas are fine in a fragment
}

/** Indices in `cycle` for a hash state (physical values snap to the nearest lead time or month, height and cell). */
export function resolve(
  h: HashState,
  cycle: Dataset,
  fallback: { variable: string; lead: number; zi: number; cell: number; stat: string },
) {
  const names = Object.keys(cycle.variables);
  const cell = h.lat !== undefined && h.lon !== undefined ? cycle.nearestCell(h.lat, h.lon) : -1;
  const clim = cycle instanceof Climatology ? cycle : undefined;
  const lead = clim
    ? h.month !== undefined ? nearestIndex(clim.meta.months, h.month) : fallback.lead
    : h.leadHours !== undefined ? nearestIndex((cycle as Cycle).meta.lead_hours, h.leadHours) : fallback.lead; // fmt: skip
  return {
    variable: h.variable && names.includes(h.variable) ? h.variable : fallback.variable,
    lead,
    stat: h.stat && clim?.meta.stats.includes(h.stat) ? h.stat : fallback.stat,
    zi: h.z !== undefined && cycle.nz ? nearestIndex(cycle.z, h.z) : fallback.zi,
    cell: cell >= 0 ? cell : fallback.cell,
  };
}
