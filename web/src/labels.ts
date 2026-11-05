// What the panels call things: formats of times and places, and per variable its label, units, number format, colour map
// and scale as shown (config.json first, then the data; a variable stored as log₁₀ can be shown linearly).

import { format } from "d3-format";
import { utcFormat } from "d3-time-format";
import { Colormap } from "./colormap";
import { Climatology, Cycle, type Dataset } from "./data";
import { numberFormat } from "./format";
import type { App, State } from "./state";

export const fmtTime = utcFormat("%a %d %b %Y %H:%M UTC");
export const fmtLatLon = (lat: number, lon: number) =>
  `${Math.abs(lat).toFixed(2)}°${lat >= 0 ? "N" : "S"} ${Math.abs(lon).toFixed(2)}°${lon >= 0 ? "E" : "W"}`;
export const fmtLead = (h: number) => `+${format("~r")(h)} h`;
export const fmtMonth = utcFormat("%B");
/** A cycle directory name (YYYYMMDDHH) as e.g. "Fri 30 Oct, 00 UTC". */
export function fmtCycle(id: string): string {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})$/.exec(id);
  return m ? utcFormat("%a %d %b, %H UTC")(new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4]))) : id;
}
export const climOf = (d: Dataset) => (d instanceof Climatology ? d : undefined);

const STAT_LABELS: Record<string, string> = {
  median: "Median",
  mean: "Mean",
  p5: "5th percentile",
  p25: "25th percentile",
  p75: "75th percentile",
  p95: "95th percentile",
  lmean: "Mean of the linear values",
};
const statLabel = (stat: string) => STAT_LABELS[stat] ?? stat;

export class Labels {
  private app: App;
  private cmaps = new Map<string, Colormap>();
  /** The log₁₀ switches at the start (config `log`) */
  readonly logDefault: Record<string, boolean>;

  constructor(app: App) {
    this.app = app;
    this.logDefault = Object.fromEntries(
      Object.keys(app.config.variables).filter((n) => this.vc(n).linear).map((n) => [n, this.vc(n).log ?? true]),
    );
  }

  private get data() {
    return this.app.data;
  }

  vc = (name: string) => this.app.config.variables[name] ?? {};
  /** A variable stored as log₁₀ (config `linear`) shown as 10^value: the log₁₀ switch is off. Values, ranges and
   * statistics are converted only for showing them (`shown`, `shownArr`, `shownRange`). */
  linear = (name: string) => !!this.vc(name).linear && this.app.store.state.logValues[name] === false;
  shown = (name: string, v: number) => (this.linear(name) ? 10 ** v : v);
  shownArr = <T extends Float32Array | undefined>(name: string, a: T): T =>
    a && this.linear(name) ? (a.map((v) => 10 ** v) as T) : a;
  shownRange = (name: string, [lo, hi]: [number, number]): [number, number] => [this.shown(name, lo), this.shown(name, hi)]; // fmt: skip
  private lin = (name: string) => (this.linear(name) ? this.vc(name).linear : undefined);
  label = (name: string) => this.lin(name)?.label ?? this.vc(name).label ?? this.data.variables[name]?.long_name ?? name;
  units = (name: string) => this.lin(name)?.units ?? this.vc(name).units ?? this.data.variables[name]?.units ?? "";
  fullLabel = (name: string) => (this.units(name) && this.units(name) !== "1" ? `${this.label(name)} [${this.units(name)}]` : this.label(name)); // fmt: skip
  fmt = (name: string) => {
    if (this.linear(name)) return numberFormat(this.lin(name)?.format ?? ".3~r");
    const f = format(this.vc(name).format ?? ".2f");
    return (v: number) => (Number.isNaN(v) ? "–" : f(v).replace("-", "−"));
  };
  /** The two means of a log₁₀ variable: `mean` (of the log₁₀ values: the geometric mean of the linear values) and
   * `lmean` (of the linear values), named for the scale shown. */
  statName = (stat: string, name: string) => {
    const unit = this.vc(name).linear?.label ?? this.label(name);
    if (stat === "lmean") return this.linear(name) ? "Mean" : `Mean of linear ${unit}`;
    return stat === "mean" && this.linear(name) ? "Geometric mean" : statLabel(stat);
  };
  statButton = (stat: string, text: string, name: string) =>
    this.linear(name) && stat === "mean" ? "Geom. mean" : this.linear(name) && stat === "lmean" ? "Mean" : text;
  cmap = (name: string) => {
    if (!this.cmaps.has(name)) this.cmaps.set(name, new Colormap(this.vc(name).colormap, this.vc(name).reverse));
    return this.cmaps.get(name)!;
  };
  clearCmaps = () => this.cmaps.clear();
  /** The hours of the statistics shown, for titles (empty without day and night in the data). */
  periodLabel = (c: Climatology) => {
    const p = c.meta.periods?.[c.period];
    if (!c.meta.periods) return "";
    return p ? `${c.period}, ${format("02d")(p.utc_hour)} UTC` : "all hours";
  };
  /** Statistic of the climatology shown for a variable (the median if it has not got the selected one). */
  statFor = (name: string): string | undefined => {
    const c = climOf(this.data);
    if (!c) return undefined;
    const { stat } = this.app.store.state;
    return c.stats(name).includes(stat) ? stat : "median";
  };
  profileVar = (s: State) => (this.data.profileVars.includes(s.variable) ? s.variable : this.data.profileVars[0]);
  stepLabel = (step: number) => {
    const d = this.data;
    return d instanceof Cycle ? `${fmtTime(d.times[step])} (${fmtLead(d.meta.lead_hours[step])})` : fmtMonth(d.times[step]);
  };
  cellLabel = (cell: number) =>
    fmtLatLon(this.data.lat[Math.floor(cell / this.data.nlon)], this.data.lon[cell % this.data.nlon]);
}
