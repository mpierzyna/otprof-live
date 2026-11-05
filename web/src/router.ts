// The view in the URL: /forecast/<variable>?run=<cycle>&t=<lead h>&z=<m>&lat=..&lon=..,
// /climatology/<variable>?month=<1-12>&stat=..&period=<day|night>&z=<m>&lat=..&lon=..; log=<names>: the log₁₀ variables
// shown as log₁₀, the others linearly. What is at its default (statistic, period, height, location, log₁₀ switches) is
// left out. A URL describes the whole view: what it leaves out is the default, not what was shown before.

import { Climatology, type Cycle, type Dataset } from "./data";
import type { State } from "./state";

export type Mode = "forecast" | "climatology";

/** Where the app is served; the deployment sets it at build time (vite.config.ts). */
export const BASE = import.meta.env.BASE_URL;

/** The view a URL asks for. */
export interface ViewRequest {
  mode?: Mode;
  run?: string;
  variable?: string;
  leadHours?: number;
  month?: number; // 1 to 12
  stat?: string;
  period?: string;
  z?: number;
  lat?: number;
  lon?: number;
  log?: string; // "0", "1" or the names of the log₁₀ variables shown as log₁₀, comma-separated
}

export function parseUrl(url: { pathname: string; search: string } = location): ViewRequest {
  const [mode, variable] = url.pathname.slice(BASE.length).split("/");
  const p = new URLSearchParams(url.search);
  const num = (k: string) => (p.has(k) && Number.isFinite(+p.get(k)!) ? +p.get(k)! : undefined);
  return {
    mode: mode === "forecast" || mode === "climatology" ? mode : undefined,
    run: p.get("run") ?? undefined,
    variable: variable || undefined,
    leadHours: num("t"),
    month: num("month"),
    stat: p.get("stat") ?? undefined,
    period: p.get("period") ?? undefined,
    z: num("z"),
    lat: num("lat"),
    lon: num("lon"),
    log: p.get("log") ?? undefined,
  };
}

/** The log₁₀ switches of the variables `names` from the URL value `log` ("0", "1" or the names shown as log₁₀) */
export function parseLog(log: string, names: string[]): Record<string, boolean> {
  const on = log.split(",");
  return Object.fromEntries(names.map((n) => [n, log === "1" || on.includes(n)]));
}

/** The URL of the view shown; `defaults`: what is left out if at these values. */
export function toUrl(
  s: State,
  data: Dataset,
  defaults: { zi: number; cell: number; log: Record<string, boolean> },
): string {
  const p = new URLSearchParams();
  if (data instanceof Climatology) {
    p.set("month", String(data.meta.months[s.step]));
    if (s.stat !== "median") p.set("stat", s.stat);
    if (s.period !== "global") p.set("period", s.period);
  } else {
    p.set("run", s.cycle);
    p.set("t", String((data as Cycle).meta.lead_hours[s.step]));
  }
  if (data.nz && s.zi !== defaults.zi) p.set("z", String(Math.round(data.z[s.zi])));
  if (s.cell >= 0 && s.cell !== defaults.cell) {
    p.set("lat", data.lat[Math.floor(s.cell / data.nlon)].toFixed(2));
    p.set("lon", data.lon[s.cell % data.nlon].toFixed(2));
  }
  const names = Object.keys(defaults.log);
  if (names.some((n) => (s.logValues[n] ?? defaults.log[n]) !== defaults.log[n]))
    p.set("log", names.filter((n) => s.logValues[n] ?? defaults.log[n]).join(","));
  return `${BASE}${s.mode}/${s.variable}?${String(p).replace(/%2C/g, ",")}`; // commas are fine in a query
}

/** The target of a link to a view of the app (`/forecast/..`, `/climatology/..`, in the notes), else undefined. */
export function viewLink(href: string): string | undefined {
  return /^\/(forecast|climatology)(\/|\?|$)/.test(href) ? BASE + href.slice(1) : undefined;
}
