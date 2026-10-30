import "@fontsource-variable/inter";
import "./style.css";
import { format } from "d3-format";
import { utcFormat } from "d3-time-format";
import { Colormap, drawColorbar } from "./colormap";
import { loadConfig } from "./config";
import { Climatology, Cycle, type Dataset, loadIndex, nearestIndex } from "./data";
import { MapView } from "./map";
import { renderNotes } from "./notes";
import { type BoxStats, DiurnalView, formatHeight, ProfileView, TimeHeightView, type Violins } from "./plots";
import { type HashState, type Mode, parseHash, resolve, type State, Store, toHash } from "./state";

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
  lmean: "Mean of linear Cₙ²",
};
const statLabel = (stat: string) => STAT_LABELS[stat] ?? stat;
/** The statistic buttons with short labels, in two groups (the distribution from low to high, the means): side by side,
 * or one below the other on narrow screens. */
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
const DISCLAIMER_KEY = "otprof-live.disclaimer"; // localStorage: "closed" once the banner was collapsed
const INDEX_POLL_MS = 10 * 60 * 1000; // new forecast runs: checked every 10 min
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
/** Index of the first time from the current hour (floored) on, -1 if all are earlier. */
function futureStep(times: Date[]): number {
  const hour = Math.floor(Date.now() / 3.6e6) * 3.6e6;
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

/** The disclaimer as a collapsible banner: its first heading is the summary; collapsed stays collapsed. */
async function setupDisclaimer(url: string) {
  const el = $<HTMLDetailsElement>("disclaimer");
  if (!(await renderNotes($("disclaimer-text"), [url]))) return;
  const heading = $("disclaimer-text").querySelector("h1, h2, h3, h4");
  if (heading) {
    $("disclaimer-title").textContent = heading.textContent;
    heading.remove();
  }
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
  document.title = config.title;
  $("title").textContent = config.title;
  $("subtitle").textContent = config.subtitle ?? "";
  if (config.disclaimer) void setupDisclaimer(new URL(config.disclaimer, location.href).href);
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
  let data: Dataset = hash.mode === "clim" && climUrl ? await openClim() : await openCycle(firstCycle);
  const climOf = (d: Dataset) => (d instanceof Climatology ? d : undefined);
  /** Lead hours shown when the forecast was left for the climatology */
  let liveLeadHours: number | undefined;

  // Presentation per variable: config.json first, then the data
  const vc = (name: string) => config.variables[name] ?? {};
  const label = (name: string) => vc(name).label ?? data.variables[name]?.long_name ?? name;
  const units = (name: string) => vc(name).units ?? data.variables[name]?.units ?? "";
  const fullLabel = (name: string) => (units(name) && units(name) !== "1" ? `${label(name)} [${units(name)}]` : label(name)); // fmt: skip
  const fmt = (name: string) => {
    const f = format(vc(name).format ?? ".2f");
    return (v: number) => (Number.isNaN(v) ? "–" : f(v).replace("-", "−"));
  };
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
      void c.loadStep(step).then(() => data instanceof Cycle && renderProfile());
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
      const v = data.value(s.variable, s.lead, s.zi, cell, statFor(s.variable));
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
  const diurnalView = new DiurnalView($("diurnal"));

  // Controls
  const timeInput = $<HTMLInputElement>("time");
  const heightInput = $<HTMLInputElement>("height");
  const play = $<HTMLButtonElement>("play");
  const logHeight = $<HTMLInputElement>("log-height");
  const colourZ = $<HTMLInputElement>("colour-z");
  const speed = $<HTMLButtonElement>("speed");
  let speedIndex = 1;
  const newer = $<HTMLButtonElement>("newer");
  const cycleSelect = $<HTMLSelectElement>("cycle-select");
  const statGroup = $("stat");
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
  speed.addEventListener("click", () => {
    speedIndex = (speedIndex + 1) % SPEEDS.length;
    speed.textContent = SPEEDS[speedIndex][1];
  });
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
  for (const b of $("diurnal-kind").querySelectorAll<HTMLButtonElement>("button"))
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
          b.title = statLabel(stat);
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
    const notes = [...(config.notes ? [new URL(config.notes, location.href).href] : [])];
    if (data.notes) notes.push(new URL(data.notes, data.base).href);
    void renderNotes($("notes"), notes);
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
    const [lo, hi] = mapRange(s.variable, s.zi, s.colourPerHeight);
    const stat = statFor(s.variable);
    mapView.draw(data.field(s.variable, s.lead, s.zi, stat), cmap(s.variable), lo, hi);
    const atZ = data.profileVars.includes(s.variable) ? ` at ${formatHeight(data.z[s.zi])}` : "";
    const ofStat = stat ? `, ${statLabel(stat).toLowerCase()}` : "";
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
      when = `${when}, ${statLabel(stat).toLowerCase()} · ${sample}`;
    }
    $("profile-sub").textContent = s.cell >= 0 ? `${cellLabel(s.cell)} · ${when}` : "Click the map to select a point";
    const values = $("column-values");
    values.innerHTML = "";
    for (const name of data.columnVars) {
      const chip = document.createElement("span");
      chip.className = name === s.variable ? "chip active" : "chip";
      const u = units(name) === "1" ? "" : ` ${units(name)}`;
      chip.textContent = `${label(name)} ${fmt(name)(data.value(name, s.lead, 0, s.cell, statFor(name)))}${u}`;
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
      drawLegend($("profile-legend"), [["", statLabel(stat!)], ...percentiles]);
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
      profile: data.profile(pv, s.lead, s.cell, stat),
      live: !c,
      bands,
      reference,
      zi: s.zi,
      showZ: data.profileVars.includes(s.variable),
      heightScale: s.heightScale,
      xDomain,
      xLabel: fullLabel(pv),
      fmt: fmt(pv),
    });
  }

  function renderTimeHeight() {
    const s = st();
    const pv = profileVar(s);
    if (!pv || s.cell < 0) return;
    const c = climOf(data);
    const stat = statFor(pv);
    $("th-title").textContent = c
      ? `Annual cycle of ${label(pv)} (${statLabel(stat!).toLowerCase()}) at ${cellLabel(s.cell)}`
      : `${label(pv)} at ${cellLabel(s.cell)}`;
    thView.draw({
      cycle: data,
      name: pv,
      cell: s.cell,
      lead: s.lead,
      zi: s.zi,
      heightScale: s.heightScale,
      cmap: cmap(pv),
      range: globalRange(pv),
      fmt: fmt(pv),
      columns: data.columnVars.map((name) => ({ name, label: fullLabel(name), fmt: fmt(name) })),
      stepLabel,
      from: firstStep,
      showZ: data.profileVars.includes(s.variable),
      stat: c ? s.stat : undefined,
      band: c ? ["p25", "p75"] : undefined,
      months: !!c,
    });
    drawColorbar($("th-colorbar"), cmap(pv), globalRange(pv), fullLabel(pv));
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
    drawLegend(
      $("diurnal-legend"),
      kind === "violin"
        ? [["violin", "Distribution"], ["box", "25th–75th percentile"], ["", "Median"], ["dot", "Mean"]]
        : [["box", "25th–75th percentile"], ["whisker", "5th–95th percentile"], ["", "Median"], ["dot", "Mean"]],
    );
    if (kind === "box") return drawDiurnal(c, kind);
    // Violins: drawn once the month is loaded (at once if it is), the previous plot stays until then
    const lead = s.lead;
    const current = () => climOf(data) === c && st().lead === lead && st().diurnalKind === "violin";
    void c.loadViolins(lead).then(() => current() && drawDiurnal(c, "violin"));
  }
  function drawDiurnal(c: Climatology, kind: "box" | "violin") {
    const s = st();
    diurnalView.draw(
      c.meta.hours,
      kind,
      c.diurnalVars.map((name) => ({
        label: fullLabel(name),
        fmt: fmt(name),
        boxes: c.diurnal(name, s.lead, s.cell) as BoxStats | undefined,
        violins: c.violin(name, s.lead, s.cell) as Violins | undefined,
      })),
    );
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
    for (const b of $("var-switch").querySelectorAll("button"))
      b.setAttribute("aria-pressed", String(b.dataset.name === s.variable));
    $("colour-z-group").hidden = !data.profileVars.includes(s.variable);
    const latest = latestCycle();
    newer.hidden = !(data instanceof Cycle) || data.id === latest;
    newer.title = `A newer forecast is available (${fmtCycle(latest)}): show it`;
    for (const b of $("mode-tabs").querySelectorAll("button"))
      b.setAttribute("aria-selected", String(b.dataset.mode === s.mode));
    const c = climOf(data);
    if (c) {
      for (const b of statGroup.querySelectorAll<HTMLButtonElement>("button")) {
        const has = c.stats(s.variable).includes(b.dataset.stat!);
        b.disabled = !has;
        b.title = has ? statLabel(b.dataset.stat!) : `${statLabel(b.dataset.stat!)}: not available for ${label(s.variable)}`;
        b.setAttribute("aria-pressed", String(b.dataset.stat === statFor(s.variable)));
      }
    }
  }

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
    if (any("lead")) void data.loadStep(s.lead);
    if (any("variable", "lead", "zi", "colourPerHeight", "stat")) renderMap();
    if (any("cell")) mapView.setSelection(s.cell);
    if (any("variable", "lead", "zi", "cell", "heightScale", "stat")) renderProfile();
    if (any("variable", "cell", "heightScale", "stat")) renderTimeHeight();
    else if (any("lead", "zi")) thView.setCursor(data, s.lead, s.zi);
    if (any("lead", "cell", "diurnalKind")) renderDiurnal();
    renderControls();
    if (any("playing")) schedulePlay();
    history.replaceState(null, "", toHash(s, data));
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
    store.state = { ...st(), mode: climOf(data) ? "clim" : "live", ...(data instanceof Cycle && { cycle: data.id }), ...r }; // fmt: skip
    await data.loadStep(r.lead);
    renderAll();
    void data.loadAll(r.lead, firstStep);
  }
  async function switchCycle(id: string, h: HashState, explicit = false) {
    await switchTo(await openCycle(id), h, explicit);
  }
  /** The climatology opens at the month of the forecast time shown; the forecast at the lead time it was left at. */
  async function switchMode(mode: Mode, extra: HashState = {}, explicit = false) {
    if (mode === st().mode || (mode === "clim" && !climUrl)) return;
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
    history.replaceState(null, "", toHash(s, data));
  }

  // Links in the notes and edits of the URL
  addEventListener("hashchange", () => {
    const h = parseHash(location.hash);
    if (h.mode && h.mode !== st().mode) return void switchMode(h.mode, h, true);
    if (data instanceof Cycle && h.cycle && h.cycle !== data.id && index.cycles.includes(h.cycle)) return void switchCycle(h.cycle, { ...physical(), ...defined(h) }, true); // fmt: skip
    const before = firstStep;
    const r = resolve(h, data, { ...st() });
    r.lead = limitSteps(r.lead, h.leadHours !== undefined);
    store.set({ ...r, playing: false });
    if (firstStep !== before) {
      renderTimeHeight();
      renderControls();
      void data.loadAll(r.lead, firstStep);
    }
  });

  addEventListener("keydown", (e) => {
    const t = e.target as HTMLElement;
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
  await data.loadStep(st().lead);
  renderAll();
  $("th-hover").textContent = TH_HINT;
  void data.loadAll(st().lead, firstStep);
  // The climatology behind the forecast profile
  if (climUrl && !clim) void openClim().then(() => data instanceof Cycle && renderProfile());
}

main().catch((e: unknown) => {
  console.error(e);
  const el = $("error");
  el.hidden = false;
  el.textContent = `Could not load the data: ${e instanceof Error ? e.message : String(e)}`;
});

