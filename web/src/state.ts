// Shared view state of all panels, mirrored in the URL (router.ts).

import type { Config } from "./config";
import { Climatology, type Cycle, type Dataset, type Index, nearestIndex } from "./data";
import type { Mode, ViewRequest } from "./router";

export interface State {
  mode: Mode;
  cycle: string;
  variable: string;
  step: number; // index into the steps: the cycle's lead times, the climatology's months
  stat: string; // statistic shown in the climatology
  period: string; // hours of the climatology's statistics: "global" (all), "day", "night"
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

/** What the parts of the app share. */
export interface App {
  config: Config;
  store: Store;
  index: Index;
  data: Dataset; // the dataset shown
  clim?: Climatology; // of all hours, once loaded: also behind the forecast profile
  firstStep: number; // first step of the time axis
}

/** Indices in `data` for a view (physical values snap to the nearest lead time or month, height and cell). */
export function resolve(
  h: ViewRequest,
  data: Dataset,
  fallback: { variable: string; step: number; zi: number; cell: number; stat: string },
) {
  const names = Object.keys(data.variables);
  const cell = h.lat !== undefined && h.lon !== undefined ? data.nearestCell(h.lat, h.lon) : -1;
  const clim = data instanceof Climatology ? data : undefined;
  const step = clim
    ? h.month !== undefined ? nearestIndex(clim.meta.months, h.month) : fallback.step
    : h.leadHours !== undefined ? nearestIndex((data as Cycle).meta.lead_hours, h.leadHours) : fallback.step; // fmt: skip
  return {
    variable: h.variable && names.includes(h.variable) ? h.variable : fallback.variable,
    step,
    stat: h.stat && clim?.meta.stats.includes(h.stat) ? h.stat : fallback.stat,
    zi: h.z !== undefined && data.nz ? nearestIndex(data.z, h.z) : fallback.zi,
    cell: cell >= 0 ? cell : fallback.cell,
  };
}
