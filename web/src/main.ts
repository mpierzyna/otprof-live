import "@fontsource-variable/inter";
import "./style.css";
import { format } from "d3-format";
import { utcFormat } from "d3-time-format";
import { Colormap, drawColorbar } from "./colormap";
import { loadConfig } from "./config";
import { numberFormat } from "./format";
import { Climatology, Cycle, type Dataset, loadIndex, nearestIndex } from "./data";
import { MapView } from "./map";
import { renderNotes } from "./notes";
import { type BoxStats, formatHeight, ProfileView, type Steps, TimeHeightView, type Violins } from "./plots";
import { type HashState, type Mode, parseHash, parseLog, resolve, type State, Store, toHash } from "./state";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const fmtTime = utcFormat("%a %d %b %Y %H:%M UTC");
const fmtLatLon = (lat: number, lon: number) =>
  `${Math.abs(lat).toFixed(2)}°${lat >= 0 ? "N" : "S"} ${Math.abs(lon).toFixed(2)}°${lon >= 0 ? "E" : "W"}`;
const fmtLead = (h: number) => `+${format("~r")(h)} h`;
const fmtMonth = utcFormat("%B");
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
/** The statistic buttons with short labels, in two groups (the distribution from low to high, the means): side by side,
 * or one below the other on narrow screens. The means of a variable shown linearly are relabelled (`statButton`). */
const STAT_BUTTONS: [string, string][][] = [
  [
    ["p5", "5th"],
    ["p25", "25th"],
    ["median", "Median"],
    ["p75", "75th"],
    ["p95", "95th"],
  ],
  [
    ["mean", "Mean"],
    ["lmean", "Lin. mean"],
  ],
];
type Panel = "map" | "profile" | "th" | "diurnal";
const PANELS: Panel[] = ["map", "profile", "th", "diurnal"];
const pendingLoads = new Map<Panel, number>();
/** The spinners of `panels` (`<panel>-spinner`) shown while `p` is pending; returns `p`. */
function loading<T>(panels: Panel[], p: Promise<T>): Promise<T> {
  const count = (id: Panel, d: number) => {
    const n = (pendingLoads.get(id) ?? 0) + d;
    pendingLoads.set(id, n);
    $(`${id}-spinner`).hidden = n === 0;
  };
  panels.forEach((id) => count(id, 1));
  const done = () => panels.forEach((id) => count(id, -1));
  p.then(done, done);
  return p;
}
/** Legend items into `el`: [swatch class (legend i.<class> in style.css), label]. */
function drawLegend(el: HTMLElement, items: [string, string][]) {
  el.replaceChildren(
    ...items.map(([cls, text]) => {
      const item = document.createElement("span");
      const swatch = document.createElement("i");
      swatch.className = cls;
      item.append(swatch, text);
      return item;
    }),
  );
}
/** The keys of `h` that are set (so that spreading it does not clear others). */
const defined = (h: HashState): HashState => Object.fromEntries(Object.entries(h).filter(([, v]) => v !== undefined));
const ICON_PLAY = "M8 5v14l11-7z";
const ICON_PAUSE = "M6 19h4V5H6v14zm8-14v14h4V5h-4z";
const fill = (input: HTMLInputElement) =>
  input.style.setProperty("--pct", `${(100 * (+input.value - +input.min)) / Math.max(1, +input.max - +input.min)}%`);
const SPEEDS: [number, string][] = [[2, "0.5×"], [1, "1×"], [0.5, "2×"], [0.25, "4×"]]; // interval factor, label
const TH_HINT = "Hover for values, click to select a time and height";
const DAY_HINT = "Hover for values, click to select a height";
const DISCLAIMER_KEY = "otprof-live.disclaimer"; // localStorage: "closed" once the banner was collapsed
const INDEX_POLL_MS = 10 * 60 * 1000; // new forecast runs: checked every 10 min
const LIVE_CHECK_MS = 30 * 1000; // the live badge: goes off soon after the hour turns
/** A cycle directory name (YYYYMMDDHH) as e.g. "Fri 30 Oct, 00 UTC". */
function fmtCycle(id: string): string {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})$/.exec(id);
  return m ? utcFormat("%a %d %b, %H UTC")(new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4]))) : id;
}
/** The step of the current hour: the first time from it on, or the last time if all are earlier. */
function nowStep(times: Date[]): number {
  const k = futureStep(times);
  return k < 0 ? times.length - 1 : k;
}
/** The start of the current hour [ms]. */
const currentHour = () => Math.floor(Date.now() / 3.6e6) * 3.6e6;
/** Index of the first time from the current hour (floored) on, -1 if all are earlier. */
function futureStep(times: Date[]): number {
  const hour = currentHour();
  return times.findIndex((t) => t.getTime() >= hour);
}

/** Theme switch (system / light / dark), stored per browser. The theme is `data-theme` on <html> (light / dark; set
 * before the first paint by public/theme.js); "system" follows the system setting while the page is open. Fires
 * `themechange` on window for what reads colours in code (the map). */
function setupTheme() {
  const KEY = "otprof-live.theme";
  const system = matchMedia("(prefers-color-scheme: dark)");
  let choice = "system";
  try {
    choice = localStorage.getItem(KEY) ?? "system";
  } catch {
    // no storage: as the system
  }
  const buttons = [...$("theme-switch").querySelectorAll<HTMLButtonElement>("button")];
  const apply = () => {
    const dark = choice === "dark" || (choice === "system" && system.matches);
    const theme = dark ? "dark" : "light";
    for (const b of buttons) b.setAttribute("aria-pressed", String(b.dataset.theme === choice));
    if (document.documentElement.dataset.theme === theme) return;
    document.documentElement.dataset.theme = theme;
    dispatchEvent(new Event("themechange"));
  };
  for (const b of buttons)
    b.addEventListener("click", () => {
      choice = b.dataset.theme!;
      try {
        if (choice === "system") localStorage.removeItem(KEY);
        else localStorage.setItem(KEY, choice);
      } catch {
        // not remembered
      }
      apply();
    });
  system.addEventListener("change", apply);
  apply();
}

/** The disclaimer (content/disclaimer.md, in the page) as a collapsible banner; collapsed stays collapsed. */
function setupDisclaimer() {
  const el = $<HTMLDetailsElement>("disclaimer");
  if (!el.textContent?.trim()) return;
  try {
    el.open = localStorage.getItem(DISCLAIMER_KEY) !== "closed";
  } catch {
    // no storage: open
  }
  el.addEventListener("toggle", () => {
    try {
      localStorage.setItem(DISCLAIMER_KEY, el.open ? "open" : "closed");
    } catch {
      // not remembered
    }
  });
  el.hidden = false;
}

async function main() {
  setupTheme();
  const config = await loadConfig();
  setupDisclaimer();
  let index = await loadIndex(config.dataUrl);
  const latestCycle = () => index.latest ?? index.cycles[0];
  const climUrl = index.climatology ? new URL(index.climatology, config.dataUrl).href : undefined;
  const hash = parseHash(location.hash);

  // The forecast cycle and the climatology are kept once loaded; `data` is the one shown
  let cycle: Cycle | undefined;
  let clim: Climatology | undefined;
  const openCycle = async (id: string) => (cycle = await Cycle.open(config.dataUrl, id));
  let climLoad: Promise<Climatology> | undefined;
  const openClim = () => (climLoad ??= Climatology.open(climUrl!).then((c) => (clim = c)));
  const firstCycle = hash.cycle && index.cycles.includes(hash.cycle) ? hash.cycle : latestCycle();
  let data: Dataset = await loading<Dataset>(PANELS, hash.mode === "clim" && climUrl ? openClim() : openCycle(firstCycle));
  const climOf = (d: Dataset) => (d instanceof Climatology ? d : undefined);
  /** Lead hours shown when the forecast was left for the climatology */
  let liveLeadHours: number | undefined;

  // Presentation per variable: config.json first, then the data
  const vc = (name: string) => config.variables[name] ?? {};
  /** A variable stored as log₁₀ (config `linear`) shown as 10^value: the log₁₀ switch is off. Values, ranges and
   * statistics are converted only for showing them (`shown`, `shownArr`, `shownRange`). */
  const linear = (name: string) => !!vc(name).linear && st().logValues[name] === false;
  /** The log₁₀ switches at the start (config `log`), and as asked for by a hash value `log` */
  const logDefault = Object.fromEntries(
    Object.keys(config.variables).filter((n) => vc(n).linear).map((n) => [n, vc(n).log ?? true]),
  );
  const logOf = (h: HashState) => (h.log === undefined ? undefined : parseLog(h.log, Object.keys(logDefault)));
  const shown = (name: string, v: number) => (linear(name) ? 10 ** v : v);
  const shownArr = <T extends Float32Array | undefined>(name: string, a: T): T =>
    a && linear(name) ? (a.map((v) => 10 ** v) as T) : a;
  const shownRange = (name: string, [lo, hi]: [number, number]): [number, number] => [shown(name, lo), shown(name, hi)];
  const lin = (name: string) => (linear(name) ? vc(name).linear : undefined);
  const label = (name: string) => lin(name)?.label ?? vc(name).label ?? data.variables[name]?.long_name ?? name;
  const units = (name: string) => lin(name)?.units ?? vc(name).units ?? data.variables[name]?.units ?? "";
  const fullLabel = (name: string) => (units(name) && units(name) !== "1" ? `${label(name)} [${units(name)}]` : label(name)); // fmt: skip
  const fmt = (name: string) => {
    if (linear(name)) return numberFormat(lin(name)?.format ?? ".3~r");
    const f = format(vc(name).format ?? ".2f");
    return (v: number) => (Number.isNaN(v) ? "–" : f(v).replace("-", "−"));
  };
  /** The two means of a log₁₀ variable: `mean` (of the log₁₀ values: the geometric mean of the linear values) and
   * `lmean` (of the linear values), named for the scale shown. */
  const statName = (stat: string, name: string) => {
    const unit = vc(name).linear?.label ?? label(name);
    if (stat === "lmean") return linear(name) ? "Mean" : `Mean of linear ${unit}`;
    return stat === "mean" && linear(name) ? "Geometric mean" : statLabel(stat);
  };
  const statButton = (stat: string, text: string, name: string) =>
    linear(name) && stat === "mean" ? "Geom. mean" : linear(name) && stat === "lmean" ? "Mean" : text;
  const cmaps = new Map<string, Colormap>();
  const cmap = (name: string) => {
    if (!cmaps.has(name)) cmaps.set(name, new Colormap(vc(name).colormap, vc(name).reverse));
    return cmaps.get(name)!;
  };
  /** Statistic of the climatology shown for a variable (the median if it has not got the selected one). */
  const statFor = (name: string): string | undefined => {
    const c = climOf(data);
    if (!c) return undefined;
    return c.stats(name).includes(st().stat) ? st().stat : "median";
  };
  const globalRange = (name: string): [number, number] => {
    const v = data.variables[name];
    const stat = statFor(name);
    return vc(name).range ?? (stat ? v.display_ranges?.[stat] : undefined) ?? v.display_range ?? v.valid_range ?? [0, 1];
  };
  const mapRange = (name: string, zi: number, perHeight: boolean): [number, number] => {
    const v = data.variables[name];
    const stat = statFor(name);
    const perZ = (stat ? v.display_ranges_z?.[stat] : undefined) ?? v.display_range_z;
    if (perHeight && !vc(name).range && perZ?.[zi]) return perZ[zi];
    return globalRange(name);
  };
  /** Profile axis: the 5th to 95th percentile range of a climatology variable, else its data range. */
  const profileDomain = (d: Dataset, name: string): [number, number] => {
    const v = d.variables[name];
    const [p5, p95] = [v.display_ranges?.p5, v.display_ranges?.p95];
    if (p5 && p95) return [p5[0], p95[1]];
    return v.valid_range ?? globalRange(name);
  };
  /** The climatology behind a forecast profile: month of the forecast time, nearest climatology cell. Undefined while
   * it loads (the profile is drawn again when it is there) or without a climatology. */
  const climBehind = (name: string, s: State) => {
    if (!(data instanceof Cycle) || !clim || !clim.profileVars.includes(name) || s.cell < 0) return undefined;
    const c = clim;
    const cell = c.nearestCell(data.lat[Math.floor(s.cell / data.nlon)], data.lon[s.cell % data.nlon]);
    const step = nearestIndex(c.meta.months, data.times[s.lead].getUTCMonth() + 1);
    if (cell < 0) return undefined;
    if (!c.hasStep(step)) {
      void loading(["profile"], c.loadStep(step)).then(() => data instanceof Cycle && renderProfile());
      return undefined;
    }
    const band = (lo: string, hi: string) => ({ z: c.z, lo: c.profile(name, step, cell, lo)!, hi: c.profile(name, step, cell, hi)! }); // fmt: skip
    return {
      bands: [band("p5", "p95"), band("p25", "p75")],
      reference: { z: c.z, values: c.profile(name, step, cell, "median")! },
      month: fmtMonth(c.times[step]),
      domain: profileDomain(c, name),
    };
  };
  const profileVar = (s: State) => (data.profileVars.includes(s.variable) ? s.variable : data.profileVars[0]);
  const stepLabel = (step: number) =>
    data instanceof Cycle
      ? `${fmtTime(data.times[step])} (${fmtLead(data.meta.lead_hours[step])})`
      : fmtMonth(data.times[step]);
  const cellLabel = (cell: number) => fmtLatLon(data.lat[Math.floor(cell / data.nlon)], data.lon[cell % data.nlon]);

  const fallback = (c: Dataset) => {
    const names = Object.keys(c.variables);
    const d = config.defaults;
    const cell = d.lat !== undefined && d.lon !== undefined ? c.nearestCell(d.lat, d.lon) : -1;
    const cl = climOf(c);
    return {
      variable: d.variable && names.includes(d.variable) ? d.variable : names[0],
      // Now: the climatology of this month, the forecast from the current hour on (or its last time if all is past)
      lead: cl ? nearestIndex(cl.meta.months, new Date().getUTCMonth() + 1) : nowStep(c.times),
      zi: c.nz ? nearestIndex(c.z, d.z ?? 100) : 0,
      cell: cell >= 0 ? cell : c.nearestCell(c.lat[c.nlat >> 1], c.lon[c.nlon >> 1]),
      stat: "median",
    };
  };
  const store = new Store({
    mode: climOf(data) ? "clim" : "live",
    cycle: firstCycle,
    ...resolve(hash, data, fallback(data)),
    playing: false,
    diurnalKind: "box",
    heightScale: config.heightScale,
    colourPerHeight: config.colourPerHeight,
    logValues: logOf(hash) ?? logDefault,
  });
  const st = () => store.state;

  /** First step of the time axis: a forecast is shown from the current hour on, unless `explicit` (the URL) asks for
   * an earlier time; then, and if all of it is past, from its start. */
  let firstStep = 0;
  const limitSteps = (lead: number, explicit: boolean): number => {
    const k = data instanceof Cycle ? futureStep(data.times) : 0;
    firstStep = k < 0 || (explicit && lead < k) ? 0 : k;
    return Math.max(lead, firstStep);
  };
  store.state.lead = limitSteps(st().lead, hash.leadHours !== undefined);

  // Views
  const tooltip = $("map-tooltip");
  const mapView = new MapView(
    $("map"),
    config.basemapUrl,
    config.mapPaddingDeg,
    (cell) => store.set({ cell }),
    (cell, point) => {
      tooltip.hidden = cell < 0 || !point;
      if (tooltip.hidden || !point) return;
      const s = st();
      const v = shown(s.variable, data.value(s.variable, s.lead, s.zi, cell, statFor(s.variable)));
      tooltip.textContent = `${cellLabel(cell)}: ${fmt(s.variable)(v)} ${units(s.variable) === "1" ? "" : units(s.variable)}`; // fmt: skip
      tooltip.style.transform = `translate(${point.x + 14}px, ${point.y + 14}px)`;
    },
  );
  const profileView = new ProfileView($("profile"), (zi) => store.set({ zi }));
  const thView = new TimeHeightView(
    $("timeheight"),
    (lead, zi) => store.set(zi === undefined ? { lead, playing: false } : { lead, zi, playing: false }),
    (text) => ($("th-hover").textContent = text || TH_HINT),
  );
  const dayView = new TimeHeightView(
    $("diurnal"),
    (_, zi) => zi !== undefined && store.set({ zi }),
    (text) => ($("diurnal-hover").textContent = text || DAY_HINT),
  );
  let daySteps: Steps | undefined; // the hours of the month shown in dayView

  // Controls
  const timeInput = $<HTMLInputElement>("time");
  const heightInput = $<HTMLInputElement>("height");
  const play = $<HTMLButtonElement>("play");
  const logHeight = $<HTMLInputElement>("log-height");
  const colourZ = $<HTMLInputElement>("colour-z");
  const logValues = $<HTMLInputElement>("log-values");
  const speed = $<HTMLButtonElement>("speed");
  let speedIndex = 1;
  const newer = $<HTMLButtonElement>("newer");
  const cycleSelect = $<HTMLSelectElement>("cycle-select");
  const statGroup = $("stat");
  const download = $<HTMLButtonElement>("download");
  const downloadDialog = $<HTMLDialogElement>("download-dialog");
  const downloadLink = $<HTMLAnchorElement>("download-link");
  // Touch: the thumb jumps on touch down; restore it when the gesture becomes a page scroll (pointercancel)
  for (const input of [timeInput, heightInput]) {
    let before: string | null = null;
    input.addEventListener("pointerdown", (e) => (before = e.pointerType === "mouse" ? null : input.value));
    input.addEventListener("pointerup", () => (before = null));
    input.addEventListener("pointercancel", () => {
      if (before !== null && before !== input.value) {
        input.value = before;
        input.dispatchEvent(new Event("input"));
      }
      before = null;
    });
  }
  timeInput.addEventListener("input", () => store.set({ lead: +timeInput.value, playing: false }));
  heightInput.addEventListener("input", () => store.set({ zi: +heightInput.value }));
  play.addEventListener("click", () => store.set({ playing: !st().playing }));
  logHeight.checked = st().heightScale === "log";
  logHeight.addEventListener("change", () => store.set({ heightScale: logHeight.checked ? "log" : "linear" }));
  colourZ.checked = st().colourPerHeight;
  colourZ.addEventListener("change", () => store.set({ colourPerHeight: colourZ.checked }));
  logValues.addEventListener("change", () =>
    store.set({ logValues: { ...st().logValues, [st().variable]: logValues.checked } }),
  );
  speed.addEventListener("click", () => {
    speedIndex = (speedIndex + 1) % SPEEDS.length;
    speed.textContent = SPEEDS[speedIndex][1];
  });
  // Download of the forecast run shown, after the disclaimer (the dialog)
  download.addEventListener("click", () => {
    store.set({ playing: false });
    downloadDialog.showModal();
  });
  downloadDialog.addEventListener("click", (e) => e.target === downloadDialog && downloadDialog.close()); // backdrop
  downloadLink.addEventListener("click", () => downloadDialog.close());
  const fillCycles = () => cycleSelect.replaceChildren(...index.cycles.map((id) => new Option(fmtCycle(id), id)));
  fillCycles();
  cycleSelect.addEventListener("change", () => switchCycle(cycleSelect.value, physical()));
  // The newest run, at the current time (the rest of the view stays)
  newer.addEventListener("click", () => void switchCycle(latestCycle(), { ...physical(), leadHours: undefined }));
  setInterval(async () => {
    try {
      const fresh = await loadIndex(config.dataUrl);
      if (fresh.cycles.join() === index.cycles.join()) return;
      index = fresh;
      fillCycles();
      if (data instanceof Cycle) cycleSelect.value = data.id;
      renderControls();
    } catch (e) {
      console.warn("Checking for new forecasts failed:", e);
    }
  }, INDEX_POLL_MS);
  $("mode-tabs").hidden = !climUrl;
  for (const b of document.querySelectorAll<HTMLButtonElement>(".kind-switch button"))
    b.addEventListener("click", () => store.set({ diurnalKind: b.dataset.kind as State["diurnalKind"] }));
  for (const b of $("mode-tabs").querySelectorAll<HTMLButtonElement>("button"))
    b.addEventListener("click", () => void switchMode(b.dataset.mode as Mode));

  function buildVariableSwitch() {
    const el = $("var-switch");
    el.innerHTML = "";
    for (const name of Object.keys(data.variables)) {
      const b = document.createElement("button");
      b.type = "button";
      b.dataset.name = name;
      b.textContent = label(name);
      b.title = data.variables[name].long_name ?? name;
      b.addEventListener("click", () => store.set({ variable: name }));
      el.append(b);
    }
  }

  const hooked = new WeakSet<Dataset>();
  function setupData() {
    const c = climOf(data);
    timeInput.max = String(data.times.length - 1);
    heightInput.max = String(Math.max(0, data.nz - 1));
    if (data instanceof Cycle) cycleSelect.value = data.id;
    const file = data instanceof Cycle ? data.meta.download : undefined;
    download.hidden = !file;
    if (data instanceof Cycle && file) {
      const size = `${(file.bytes / 1e6).toFixed(1)} MB`;
      $("download-label").textContent = `nc (${size})`;
      downloadLink.href = new URL(file.file, data.base).href;
      downloadLink.download = file.file;
      downloadLink.textContent = `Download (${size})`;
      $("download-what").textContent = `Forecast run ${fmtCycle(data.id)} as NetCDF: ${file.file}, ${size}.`;
    }
    $("cycle-group").hidden = !!c;
    $("stat-group").hidden = !c;
    $("diurnal-panel").hidden = !c;
    $("time-name").textContent = c ? "Month" : "Time";
    document.querySelector(".layout")!.classList.toggle("clim", !!c);
    if (c && !statGroup.childElementCount)
      for (const buttons of STAT_BUTTONS) {
        const group = document.createElement("div");
        group.className = "segmented";
        for (const [stat, text] of buttons.filter(([k]) => c.meta.stats.includes(k))) {
          const b = document.createElement("button");
          b.type = "button";
          b.dataset.stat = stat;
          b.textContent = text;
          b.dataset.text = text;
          b.addEventListener("click", () => store.set({ stat }));
          group.append(b);
        }
        if (group.childElementCount) statGroup.append(group);
      }
    buildVariableSwitch();
    const info = $("info");
    info.innerHTML = "";
    const grid: [string, string] = ["Grid", `${data.nlat} × ${data.nlon} cells, ${data.nz} heights`];
    const rows: [string, string][] =
      data instanceof Cycle
        ? [
            ["Initialised", fmtTime(new Date(data.meta.cycle))],
            ["Lead times", `${fmtLead(data.meta.lead_hours[0])} to ${fmtLead(data.meta.lead_hours.at(-1)!)} (${data.meta.lead_hours.length})`], // fmt: skip
            grid,
            ...Object.entries(data.info),
          ]
        : [["Climatology", "per calendar month"], grid, ...Object.entries(data.info)];
    for (const [k, v] of rows) {
      const dt = document.createElement("dt");
      dt.textContent = k;
      const dd = document.createElement("dd");
      dd.textContent = v;
      info.append(dt, dd);
    }
    // The texts of the page (content/) and the notes of the data, if any
    $("notes-live").hidden = !!climOf(data);
    $("notes-clim").hidden = !climOf(data);
    void renderNotes($("notes-data"), data.notes ? [new URL(data.notes, data.base).href] : []);
    if (hooked.has(data)) return;
    hooked.add(data);
    const d = data;
    d.onStep((lead) => {
      if (d !== data) return; // a dataset switched away from while loading
      if (lead === st().lead) {
        renderMap();
        renderProfile();
      }
      scheduleTimeHeight();
      renderStatus();
    });
  }

  // Rendering
  function renderMap() {
    const s = st();
    const [lo, hi] = shownRange(s.variable, mapRange(s.variable, s.zi, s.colourPerHeight));
    const stat = statFor(s.variable);
    mapView.draw(shownArr(s.variable, data.field(s.variable, s.lead, s.zi, stat)), cmap(s.variable), lo, hi);
    const atZ = data.profileVars.includes(s.variable) ? ` at ${formatHeight(data.z[s.zi])}` : "";
    const ofStat = stat ? `, ${statName(stat, s.variable).toLowerCase()}` : "";
    drawColorbar($("colorbar"), cmap(s.variable), [lo, hi], `${fullLabel(s.variable)}${ofStat}${atZ}`);
  }

  function renderProfile() {
    const s = st();
    const pv = profileVar(s);
    const c = climOf(data);
    const stat = pv && statFor(pv);
    $("profile-title").textContent = pv ? fullLabel(pv) : "Profile";
    let when = stepLabel(s.lead);
    if (c && stat) {
      const years = c.meta.years[s.lead] ?? [];
      const sample = years.length > 3 ? `${years.length} years, ${years[0]}–${years.at(-1)}` : `${years.length > 1 ? "years" : "year"} ${years.join(", ")}`; // fmt: skip
      when = `${when}, ${statName(stat, pv!).toLowerCase()} · ${sample}`;
    }
    $("profile-sub").textContent = s.cell >= 0 ? `${cellLabel(s.cell)} · ${when}` : "Click the map to select a point";
    const values = $("column-values");
    values.innerHTML = "";
    for (const name of data.columnVars) {
      const chip = document.createElement("span");
      chip.className = name === s.variable ? "chip active" : "chip";
      const u = units(name) === "1" ? "" : ` ${units(name)}`;
      chip.textContent = `${label(name)} ${fmt(name)(shown(name, data.value(name, s.lead, 0, s.cell, statFor(name))))}${u}`;
      values.append(chip);
    }
    if (!pv || s.cell < 0) return drawLegend($("profile-legend"), []);
    // Context: the climatology (25th–75th, 5th–95th percentile, median), of the forecast's month behind a forecast
    const percentiles: [string, string][] = [["band-inner", "25th–75th percentile"], ["band", "5th–95th percentile"]];
    let bands: { z: number[]; lo: Float32Array; hi: Float32Array }[] = [];
    let reference: { z: number[]; values: Float32Array } | undefined;
    let xDomain = profileDomain(data, pv);
    if (c) {
      const band = (lo: string, hi: string) => ({ z: data.z, lo: data.profile(pv, s.lead, s.cell, lo), hi: data.profile(pv, s.lead, s.cell, hi) }); // fmt: skip
      bands = [band("p5", "p95"), band("p25", "p75")].filter((b) => b.lo && b.hi) as typeof bands;
      drawLegend($("profile-legend"), [["", statName(stat!, pv)], ...percentiles]);
    } else {
      const behind = climBehind(pv, s);
      if (behind) {
        ({ bands, reference } = behind);
        xDomain = [Math.min(xDomain[0], behind.domain[0]), Math.max(xDomain[1], behind.domain[1])];
      }
      drawLegend($("profile-legend"), [
        ["live", "Forecast"],
        ...(behind ? ([["dashed", `Climatology ${behind.month}: median`], ...percentiles] as [string, string][]) : []),
      ]);
    }
    profileView.draw({
      z: data.z,
      profile: shownArr(pv, data.profile(pv, s.lead, s.cell, stat)),
      live: !c,
      bands: bands.map((b) => ({ ...b, lo: shownArr(pv, b.lo), hi: shownArr(pv, b.hi) })),
      reference: reference && { ...reference, values: shownArr(pv, reference.values) },
      zi: s.zi,
      showZ: data.profileVars.includes(s.variable),
      heightScale: s.heightScale,
      xDomain: shownRange(pv, xDomain),
      xLabel: fullLabel(pv),
      fmt: fmt(pv),
    });
  }

  /** `boxOnly`: the annual cycle as box plots even if violins are selected (their densities failed to load). */
  function renderTimeHeight(boxOnly = false) {
    const s = st();
    const pv = profileVar(s);
    if (!pv || s.cell < 0) return;
    const c = climOf(data);
    const stat = statFor(pv);
    // Climatology: the column variables per month as box plots or violins
    const kind = c?.monthViolinVars.length && !boxOnly ? s.diurnalKind : "box";
    $("th-kind").hidden = !c?.monthViolinVars.length;
    for (const b of $("th-kind").querySelectorAll<HTMLButtonElement>("button"))
      b.setAttribute("aria-pressed", String(b.dataset.kind === kind));
    if (c && kind === "violin" && c.monthViolinVars.some((n) => !c.monthViolin(n, s.cell, linear(n)))) {
      // Drawn once the densities are loaded, the previous plot stays until then
      const current = () => climOf(data) === c && st().diurnalKind === "violin";
      void loading(["th"], c.loadMonthViolins(linear)).then(
        () => current() && renderTimeHeight(),
        (e) => (console.warn("Loading the violins of the annual cycle failed:", e), current() && renderTimeHeight(true)),
      );
      return;
    }
    drawLegend($("th-legend"), c ? boxLegend(c, kind, c.columnVars) : []);
    $("th-title").textContent = `${c ? "Annual cycle" : "Forecast"} at ${cellLabel(s.cell)}`;
    thView.draw({
      cycle: data,
      name: pv,
      cell: s.cell,
      lead: s.lead,
      zi: s.zi,
      heightScale: s.heightScale,
      label: c ? `${label(pv)} (${statName(stat!, pv).toLowerCase()})` : label(pv),
      cmap: cmap(pv),
      range: shownRange(pv, globalRange(pv)),
      fmt: fmt(pv),
      tf: linear(pv) ? (v) => 10 ** v : undefined,
      columns: data.columnVars.map((name) => ({
        name,
        label: fullLabel(name),
        fmt: fmt(name),
        tf: linear(name) ? (v: number) => 10 ** v : undefined,
        boxes: c && shownBoxes(name, Object.fromEntries(c.stats(name).map((k) => [k, c.series(name, s.cell, k)]))),
        violins: c && kind === "violin" ? shownViolins(name, c.monthViolin(name, s.cell, linear(name))) : undefined,
      })),
      stepLabel,
      from: firstStep,
      showZ: data.profileVars.includes(s.variable),
      stat: c ? s.stat : undefined,
      band: c ? ["p25", "p75"] : undefined,
      months: !!c,
    });
    drawColorbar($("th-colorbar"), cmap(pv), shownRange(pv, globalRange(pv)), fullLabel(pv));
  }

  function renderDiurnal() {
    const s = st();
    const c = climOf(data);
    if (!c || s.cell < 0) return;
    $("diurnal-title").textContent = `Diurnal cycle in ${fmtMonth(c.times[s.lead])} at ${cellLabel(s.cell)}`;
    const kind = c.violinVars.length ? s.diurnalKind : "box";
    $("diurnal-kind").hidden = !c.violinVars.length;
    for (const b of $("diurnal-kind").querySelectorAll<HTMLButtonElement>("button"))
      b.setAttribute("aria-pressed", String(b.dataset.kind === kind));
    drawLegend($("diurnal-legend"), boxLegend(c, kind, c.diurnalVars, (n) => c.variables[n].diurnal?.stats));
    // Drawn once the profiles of the cell (and the violins of the month) are loaded (at once if they are), the previous
    // plot stays until then
    const { lead, cell } = s;
    const pv = profileVar(s);
    const current = () => climOf(data) === c && st().lead === lead && st().cell === cell;
    const loads = Promise.all([
      pv && c.hasDiurnalProfiles(pv) ? c.loadDiurnalProfiles(pv, cell) : undefined,
      kind === "violin" ? c.loadViolins(lead, linear) : undefined,
    ]);
    void loading(["diurnal"], loads).then(
      () => current() && drawDiurnal(c),
      (e) => (console.warn("Loading the diurnal cycle failed:", e), current() && drawDiurnal(c)),
    );
  }
  /** The diurnal cycle of the month and cell selected: the profile variable over the hours, the column variables as
   * box plots or violins below. */
  function drawDiurnal(c: Climatology) {
    const s = st();
    const pv = profileVar(s);
    if (!pv) return;
    const stat = statFor(pv)!;
    const kind = c.violinVars.length ? s.diurnalKind : "box";
    const hours = c.meta.hours;
    daySteps = {
      times: hours.map((h) => new Date(Date.UTC(2001, 0, 1, h))),
      z: c.z,
      nz: c.nz,
      profile: (name, h, cell, stat) => c.diurnalProfile(name, s.lead, h, cell, stat),
      series: () => new Float32Array(hours.length).fill(NaN),
    };
    dayView.draw({
      cycle: daySteps,
      name: pv,
      cell: s.cell,
      lead: -1,
      zi: s.zi,
      heightScale: s.heightScale,
      label: `${label(pv)} (${statName(stat, pv).toLowerCase()})`,
      cmap: cmap(pv),
      range: shownRange(pv, globalRange(pv)),
      fmt: fmt(pv),
      tf: linear(pv) ? (v) => 10 ** v : undefined,
      columns: c.diurnalVars.map((name) => ({
        name,
        label: fullLabel(name),
        fmt: fmt(name),
        boxes: shownBoxes(name, c.diurnal(name, s.lead, s.cell)),
        violins: kind === "violin" ? shownViolins(name, c.violin(name, s.lead, s.cell, linear(name))) : undefined,
      })),
      stepLabel: (h) => `${fmtMonth(c.times[s.lead])}, ${format("02d")(hours[h])}:00 UTC`,
      stat,
      showZ: data.profileVars.includes(s.variable),
      hours: true,
    });
    drawColorbar($("diurnal-colorbar"), cmap(pv), shownRange(pv, globalRange(pv)), fullLabel(pv));
  }
  /** Box statistics per step as shown; shown linearly, the mean is that of the linear values (lmean) if there. */
  function shownBoxes(name: string, stats: Record<string, Float32Array> | undefined): BoxStats | undefined {
    if (!stats) return undefined;
    const boxes = Object.fromEntries(Object.entries(stats).map(([k, a]) => [k, shownArr(name, a)])) as BoxStats;
    if (boxes.lmean && linear(name)) boxes.mean = boxes.lmean;
    return boxes;
  }
  /** Legend of box plots or violins of `names`; `stats`: their statistics (default: the monthly ones). */
  function boxLegend(c: Climatology, kind: "box" | "violin", names: string[], stats: (n: string) => string[] | undefined = (n) => c.stats(n)): [string, string][] { // fmt: skip
    // Shown linearly without lmean, the mean is the geometric mean
    const geometric = names.filter((n) => linear(n) && !stats(n)?.includes("lmean")).map(label);
    const mean = geometric.length ? `Mean (geometric of ${geometric.join(", ")})` : "Mean";
    return kind === "violin"
      ? [["violin", "Distribution"], ["box", "25th–75th percentile"], ["", "Median"], ["dot", mean]]
      : [["box", "25th–75th percentile"], ["whisker", "5th–95th percentile"], ["", "Median"], ["dot", mean]];
  }
  /** Violins of a log₁₀ variable shown linearly: those of the linear values if the data have them, else the log₁₀
   * densities per linear unit (divided by 10^value), scaled to a maximum of 1 again. */
  function shownViolins(name: string, v: (Violins & { linear: boolean }) | undefined): Violins | undefined {
    if (!v || !linear(name) || v.linear) return v;
    const x = v.x.map((e) => 10 ** e);
    const density = v.density.map((d) => {
      const per = d.map((p, i) => p / x[i]);
      const max = per.reduce((m, p) => (p > m ? p : m), 0);
      return max > 0 ? per.map((p) => p / max) : per;
    });
    return { x, density };
  }
  let thTimer = 0;
  function scheduleTimeHeight() {
    if (!thTimer) thTimer = window.setTimeout(() => ((thTimer = 0), renderTimeHeight()), 150);
  }

  function renderControls() {
    const s = st();
    timeInput.min = String(firstStep);
    timeInput.value = String(s.lead);
    $("time-label").textContent = stepLabel(s.lead);
    heightInput.value = String(s.zi);
    heightInput.disabled = !data.nz;
    $("height-label").textContent = data.nz ? formatHeight(data.z[s.zi]) : "–";
    // Column-integrated variables on the map: no height to choose (the profile's is picked in its plots)
    $("height-group").hidden = !data.profileVars.includes(s.variable);
    fill(timeInput);
    fill(heightInput);
    $("play-icon").setAttribute("d", s.playing ? ICON_PAUSE : ICON_PLAY);
    play.setAttribute("aria-label", s.playing ? "Pause" : "Play");
    for (const b of $("var-switch").querySelectorAll<HTMLButtonElement>("button")) {
      b.setAttribute("aria-pressed", String(b.dataset.name === s.variable));
      b.textContent = label(b.dataset.name!);
    }
    // log₁₀ or linear: for the variables stored as log₁₀ (the others keep the switch, disabled)
    logValues.disabled = !vc(s.variable).linear;
    logValues.checked = !logValues.disabled && s.logValues[s.variable] !== false;
    $("log-values-group").title = logValues.disabled
      ? `${label(s.variable)} has no logarithmic scale`
      : `Logarithmic (log₁₀) or linear values of ${vc(s.variable).linear?.label ?? s.variable}`;
    $("colour-z-group").hidden = !data.profileVars.includes(s.variable);
    const latest = latestCycle();
    newer.hidden = !(data instanceof Cycle) || data.id === latest;
    newer.title = `A newer forecast is available (${fmtCycle(latest)}): show it`;
    renderLive();
    for (const b of $("mode-tabs").querySelectorAll("button"))
      b.setAttribute("aria-selected", String(b.dataset.mode === s.mode));
    const c = climOf(data);
    if (c) {
      for (const b of statGroup.querySelectorAll<HTMLButtonElement>("button")) {
        const has = c.stats(s.variable).includes(b.dataset.stat!);
        b.disabled = !has;
        const name = statName(b.dataset.stat!, s.variable);
        b.textContent = statButton(b.dataset.stat!, b.dataset.text!, s.variable);
        b.title = has ? name : `${name}: not available for ${label(s.variable)}`;
        b.setAttribute("aria-pressed", String(b.dataset.stat === statFor(s.variable)));
      }
    }
  }

  /** The live badge: the newest forecast run at the current hour. */
  function renderLive() {
    $("live-badge").hidden = !(
      data instanceof Cycle &&
      data.id === latestCycle() &&
      data.times[st().lead].getTime() === currentHour()
    );
  }
  setInterval(renderLive, LIVE_CHECK_MS); // the selection stays, the time moves on

  function renderStatus() {
    const total = data.times.length - firstStep;
    const n = data.loadedCount(firstStep);
    const bar = $("progress");
    bar.hidden = n >= total;
    bar.title = `Loading ${climOf(data) ? "months" : "lead times"}: ${n}/${total}`;
    (bar.firstElementChild as HTMLElement).style.width = `${(100 * n) / total}%`;
  }

  // Playback: waits for lead times that are not loaded yet
  let playTimer = 0;
  function schedulePlay() {
    clearTimeout(playTimer);
    if (!st().playing) return;
    playTimer = window.setTimeout(async () => {
      const next = st().lead + 1 < data.times.length ? st().lead + 1 : firstStep;
      await data.loadStep(next);
      if (st().playing) {
        store.set({ lead: next });
        schedulePlay();
      }
    }, config.playIntervalMs * SPEEDS[speedIndex][0]);
  }

  store.subscribe((s, ch) => {
    const any = (...keys: (keyof State)[]) => keys.some((k) => ch.has(k));
    if (any("lead")) void loading(["map", "profile"], data.loadStep(s.lead));
    if (any("variable", "lead", "zi", "colourPerHeight", "stat", "logValues")) renderMap();
    if (any("cell")) mapView.setSelection(s.cell);
    if (any("variable", "lead", "zi", "cell", "heightScale", "stat", "logValues")) renderProfile();
    if (any("variable", "cell", "heightScale", "stat", "logValues", "diurnalKind")) renderTimeHeight();
    else if (any("lead", "zi")) thView.setCursor(data, s.lead, s.zi);
    if (any("variable", "lead", "cell", "heightScale", "stat", "diurnalKind", "logValues")) renderDiurnal();
    else if (any("zi") && daySteps) dayView.setCursor(daySteps, -1, s.zi);
    renderControls();
    if (any("playing")) schedulePlay();
    history.replaceState(null, "", toHash(s, data, logDefault));
  });

  // Switching cycles or between forecast and climatology keeps the physical view (lead hours or month, height,
  // location)
  const physical = (): HashState => {
    const s = st();
    return defined({
      variable: s.variable,
      leadHours: data instanceof Cycle ? data.meta.lead_hours[s.lead] : undefined,
      month: climOf(data)?.meta.months[s.lead],
      stat: s.stat,
      z: data.z[s.zi],
      lat: s.cell >= 0 ? data.lat[Math.floor(s.cell / data.nlon)] : undefined,
      lon: s.cell >= 0 ? data.lon[s.cell % data.nlon] : undefined,
    });
  };
  /** Show `next` at the physical view `h`; `explicit`: `h` comes from the URL (it may ask for past times). */
  async function switchTo(next: Dataset, h: HashState, explicit = false) {
    store.set({ playing: false });
    data = next;
    cmaps.clear();
    setupData();
    await mapView.setCycle(data);
    const r = resolve(h, data, fallback(data));
    r.lead = limitSteps(r.lead, explicit && (h.leadHours !== undefined || h.month !== undefined));
    store.state = { ...st(), mode: climOf(data) ? "clim" : "live", ...(data instanceof Cycle && { cycle: data.id }), ...r, logValues: logOf(h) ?? st().logValues }; // fmt: skip
    await data.loadStep(r.lead);
    renderAll();
    void loading(["th"], data.loadAll(r.lead, firstStep));
  }
  async function switchCycle(id: string, h: HashState, explicit = false) {
    await loading(PANELS, openCycle(id).then((next) => switchTo(next, h, explicit)));
  }
  /** The climatology opens at the month of the forecast time shown; the forecast at the lead time it was left at. */
  async function switchMode(mode: Mode, extra: HashState = {}, explicit = false) {
    if (mode === st().mode || (mode === "clim" && !climUrl)) return;
    await loading(PANELS, switchModeTo(mode, extra, explicit));
  }
  async function switchModeTo(mode: Mode, extra: HashState, explicit: boolean) {
    const h = physical();
    if (mode === "clim") {
      liveLeadHours = h.leadHours;
      if (data instanceof Cycle) h.month = data.times[st().lead].getUTCMonth() + 1;
      return switchTo(await openClim(), { ...h, ...defined(extra) }, explicit);
    }
    const id = extra.cycle && index.cycles.includes(extra.cycle) ? extra.cycle : st().cycle;
    const next = cycle?.id === id ? cycle : await openCycle(id);
    await switchTo(next, { ...h, leadHours: liveLeadHours, ...defined(extra) }, explicit);
  }
  function renderAll() {
    const s = st();
    renderMap();
    mapView.setSelection(s.cell);
    renderProfile();
    renderTimeHeight();
    renderDiurnal();
    renderControls();
    renderStatus();
    history.replaceState(null, "", toHash(s, data, logDefault));
  }

  // Links in the notes and edits of the URL
  addEventListener("hashchange", () => {
    const h = parseHash(location.hash);
    if (h.mode && h.mode !== st().mode) return void switchMode(h.mode, h, true);
    if (data instanceof Cycle && h.cycle && h.cycle !== data.id && index.cycles.includes(h.cycle)) return void switchCycle(h.cycle, { ...physical(), ...defined(h) }, true); // fmt: skip
    const before = firstStep;
    const r = resolve(h, data, { ...st() });
    r.lead = limitSteps(r.lead, h.leadHours !== undefined);
    const log = logOf(h);
    store.set({ ...r, playing: false, ...(log && { logValues: log }) });
    if (firstStep !== before) {
      renderTimeHeight();
      renderControls();
      void data.loadAll(r.lead, firstStep);
    }
  });

  addEventListener("keydown", (e) => {
    const t = e.target as HTMLElement;
    if (downloadDialog.open) return;
    if (t.tagName === "SELECT" || (t.tagName === "INPUT" && (t as HTMLInputElement).type !== "checkbox")) return;
    const s = st();
    const n = data.times.length;
    const step: Record<string, () => Partial<State>> = {
      " ": () => ({ playing: !s.playing }),
      ArrowRight: () => ({ lead: s.lead + 1 < n ? s.lead + 1 : firstStep, playing: false }),
      ArrowLeft: () => ({ lead: s.lead > firstStep ? s.lead - 1 : n - 1, playing: false }),
      ArrowUp: () => ({ zi: Math.min(data.nz - 1, s.zi + 1) }),
      ArrowDown: () => ({ zi: Math.max(0, s.zi - 1) }),
    };
    if (!step[e.key]) return;
    e.preventDefault();
    store.set(step[e.key]());
  });

  let resizeFrame = 0;
  const onResize = () => {
    cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(() => {
      renderMap();
      renderProfile();
      renderTimeHeight();
      renderDiurnal();
    });
  };
  new ResizeObserver(onResize).observe($("profile"));
  new ResizeObserver(onResize).observe($("timeheight"));
  new ResizeObserver(onResize).observe($("diurnal"));

  setupData();
  await mapView.setCycle(data);
  await loading(PANELS, data.loadStep(st().lead));
  renderAll();
  $("th-hover").textContent = TH_HINT;
  void loading(["th"], data.loadAll(st().lead, firstStep));
  // The climatology behind the forecast profile
  if (climUrl && !clim) void loading(["profile"], openClim()).then(() => data instanceof Cycle && renderProfile());
}

main().catch((e: unknown) => {
  console.error(e);
  const el = $("error");
  el.hidden = false;
  el.textContent = `Could not load the data: ${e instanceof Error ? e.message : String(e)}`;
});

