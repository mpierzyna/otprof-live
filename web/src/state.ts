// Shared view state of all panels, mirrored in the URL hash (#cycle=..&var=..&t=<lead h>&z=<m>&lat=..&lon=..).

import { type Cycle, nearestIndex } from "./data";

export interface State {
  cycle: string;
  variable: string;
  lead: number; // index into the cycle's lead times
  zi: number; // index into the heights
  cell: number; // lat index * nlon + lon index, -1 for none
  playing: boolean;
  heightScale: "log" | "linear";
  colourPerHeight: boolean;
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
  cycle?: string;
  variable?: string;
  leadHours?: number;
  z?: number;
  lat?: number;
  lon?: number;
}

export function parseHash(hash: string): HashState {
  const p = new URLSearchParams(hash.replace(/^#/, ""));
  const num = (k: string) => (p.has(k) && Number.isFinite(+p.get(k)!) ? +p.get(k)! : undefined);
  return {
    cycle: p.get("cycle") ?? undefined,
    variable: p.get("var") ?? undefined,
    leadHours: num("t"),
    z: num("z"),
    lat: num("lat"),
    lon: num("lon"),
  };
}

export function toHash(s: State, cycle: Cycle): string {
  const p = new URLSearchParams({ cycle: s.cycle, var: s.variable, t: String(cycle.meta.lead_hours[s.lead]) });
  if (cycle.nz) p.set("z", String(Math.round(cycle.z[s.zi])));
  if (s.cell >= 0) {
    p.set("lat", cycle.meta.lat[Math.floor(s.cell / cycle.nlon)].toFixed(2));
    p.set("lon", cycle.meta.lon[s.cell % cycle.nlon].toFixed(2));
  }
  return `#${p}`;
}

/** Indices in `cycle` for a hash state (physical values snap to the nearest lead time, height and cell). */
export function resolve(h: HashState, cycle: Cycle, fallback: { variable: string; lead: number; zi: number; cell: number }) {
  const names = Object.keys(cycle.meta.variables);
  const cell = h.lat !== undefined && h.lon !== undefined ? cycle.nearestCell(h.lat, h.lon) : -1;
  return {
    variable: h.variable && names.includes(h.variable) ? h.variable : fallback.variable,
    lead: h.leadHours !== undefined ? nearestIndex(cycle.meta.lead_hours, h.leadHours) : fallback.lead,
    zi: h.z !== undefined && cycle.nz ? nearestIndex(cycle.z, h.z) : fallback.zi,
    cell: cell >= 0 ? cell : fallback.cell,
  };
}
