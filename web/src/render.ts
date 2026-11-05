// Draws the state: map, profile, annual or forecast time-height plot, diurnal cycle, controls. Reads the dataset shown and
// the state from `App`; changes only the page.

import { format } from "d3-format";
import { drawColorbar } from "./colormap";
import { Climatology, Cycle, type Dataset, latestCycle, nearestIndex } from "./data";
import { fmtBytes } from "./download";
import { climOf, fmtCycle, fmtLead, fmtMonth, fmtTime, type Labels } from "./labels";
import { MapView } from "./map";
import { renderNotes } from "./notes";
import { type BoxStats, formatHeight, ProfileView, type Steps, TimeHeightView, type Violins } from "./plots";
import type { App, Key, State } from "./state";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

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
const TH_HINT = "Click to select the time and height";
const DAY_HINT = "Click to select the height";
const ICON_PLAY = "M8 5v14l11-7z";
const ICON_PAUSE = "M6 19h4V5H6v14zm8-14v14h4V5h-4z";

type Panel = "map" | "profile" | "th" | "diurnal";
export const PANELS: Panel[] = ["map", "profile", "th", "diurnal"];
const pendingLoads = new Map<Panel, number>();
/** The spinners of `panels` (`<panel>-spinner`) shown while `p` is pending; returns `p`. */
export function loading<T>(panels: Panel[], p: Promise<T>): Promise<T> {
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

const fill = (input: HTMLInputElement) =>
  input.style.setProperty("--pct", `${(100 * (+input.value - +input.min)) / Math.max(1, +input.max - +input.min)}%`);
const forecastInfo = (d: Cycle): [string, string][] => [
  ["Initialised", fmtTime(new Date(d.meta.cycle))],
  ["Lead times", `${fmtLead(d.meta.lead_hours[0])} to ${fmtLead(d.meta.lead_hours.at(-1)!)} (${d.meta.lead_hours.length})`], // fmt: skip
];
/** The start of the current hour [ms]. */
export const currentHour = () => Math.floor(Date.now() / 3.6e6) * 3.6e6;

export class Renderer {
  private app: App;
  private l: Labels;
  readonly mapView: MapView;
  private profileView: ProfileView;
  private thView: TimeHeightView;
  private dayView: TimeHeightView;
  private daySteps?: Steps; // the hours of the month shown in dayView
  private thTimer = 0;
  private hooked = new WeakSet<Dataset>();

  constructor(app: App, labels: Labels) {
    this.app = app;
    this.l = labels;
    const { store, config } = app;
    const tooltip = $("map-tooltip");
    this.mapView = new MapView(
      $("map"),
      config.basemapUrl,
      config.mapPaddingDeg,
      (cell) => store.set({ cell }),
      (cell, point) => {
        tooltip.hidden = cell < 0 || !point;
        if (tooltip.hidden || !point) return;
        const s = this.s;
        const { shown, statFor, cellLabel, fmt, units } = this.l;
        const v = shown(s.variable, this.data.value(s.variable, s.step, s.zi, cell, statFor(s.variable)));
        tooltip.textContent = `${cellLabel(cell)}: ${fmt(s.variable)(v)} ${units(s.variable) === "1" ? "" : units(s.variable)}`; // fmt: skip
        tooltip.style.transform = `translate(${point.x + 14}px, ${point.y + 14}px)`;
      },
    );
    this.profileView = new ProfileView($("profile"), (zi) => store.set({ zi }));
    this.thView = new TimeHeightView(
      $("timeheight"),
      (step, zi) => store.set(zi === undefined ? { step, playing: false } : { step, zi, playing: false }),
      TH_HINT,
    );
    this.dayView = new TimeHeightView(
      $("diurnal"),
      (_, zi) => zi !== undefined && store.set({ zi }),
      DAY_HINT,
    );
  }

  private get data() {
    return this.app.data;
  }
  private get s() {
    return this.app.store.state;
  }

  private globalRange(name: string): [number, number] {
    const v = this.data.variables[name];
    const stat = this.l.statFor(name);
    return this.l.vc(name).range ?? (stat ? v.display_ranges?.[stat] : undefined) ?? v.display_range ?? v.valid_range ?? [0, 1]; // fmt: skip
  }
  private mapRange(name: string, zi: number, perHeight: boolean): [number, number] {
    const v = this.data.variables[name];
    const stat = this.l.statFor(name);
    const perZ = (stat ? v.display_ranges_z?.[stat] : undefined) ?? v.display_range_z;
    if (perHeight && !this.l.vc(name).range && perZ?.[zi]) return perZ[zi];
    return this.globalRange(name);
  }
  /** Profile axis: the 5th to 95th percentile range of a climatology variable, else its data range. */
  private profileDomain(d: Dataset, name: string): [number, number] {
    const v = d.variables[name];
    const [p5, p95] = [v.display_ranges?.p5, v.display_ranges?.p95];
    if (p5 && p95) return [p5[0], p95[1]];
    return v.valid_range ?? this.globalRange(name);
  }
  /** The climatology behind a forecast profile: month of the forecast time, nearest climatology cell. Undefined while
   * it loads (the profile is drawn again when it is there) or without a climatology. */
  private climBehind(name: string, s: State) {
    const { data, clim: c } = this.app;
    if (!(data instanceof Cycle) || !c || !c.profileVars.includes(name) || s.cell < 0) return undefined;
    const cell = c.nearestCell(data.lat[Math.floor(s.cell / data.nlon)], data.lon[s.cell % data.nlon]);
    const step = nearestIndex(c.meta.months, data.times[s.step].getUTCMonth() + 1);
    if (cell < 0) return undefined;
    if (!c.hasStep(step)) {
      void loading(["profile"], c.loadStep(step)).then(() => this.app.data instanceof Cycle && this.profile());
      return undefined;
    }
    const band = (lo: string, hi: string) => ({ z: c.z, lo: c.profile(name, step, cell, lo)!, hi: c.profile(name, step, cell, hi)! }); // fmt: skip
    return {
      bands: [band("p5", "p95"), band("p25", "p75")],
      reference: { z: c.z, values: c.profile(name, step, cell, "median")! },
      month: fmtMonth(c.times[step]),
      domain: this.profileDomain(c, name),
    };
  }

  private buildVariableSwitch() {
    const el = $("var-switch");
    el.innerHTML = "";
    for (const name of Object.keys(this.data.variables)) {
      const b = document.createElement("button");
      b.type = "button";
      b.dataset.name = name;
      b.textContent = this.l.label(name);
      b.title = this.data.variables[name].long_name ?? name;
      b.addEventListener("click", () => this.app.store.set({ variable: name }));
      el.append(b);
    }
  }

  /** The page for the dataset shown: what it offers, its notes; drawn again as its steps arrive. */
  setupData() {
    const { data } = this;
    const c = climOf(data);
    $<HTMLInputElement>("time").max = String(data.times.length - 1);
    $<HTMLInputElement>("height").max = String(Math.max(0, data.nz - 1));
    if (data instanceof Cycle) $<HTMLSelectElement>("cycle-select").value = data.id;
    const file = data instanceof Cycle ? data.meta.download : undefined;
    $("download").hidden = !file;
    if (file) $("download-label").textContent = `nc (${fmtBytes(file.bytes)})`;
    $("cycle-group").hidden = !!c;
    $("stat-group").hidden = !c;
    $("period").hidden = !c?.meta.periods;
    for (const b of $("period").querySelectorAll<HTMLButtonElement>("button")) {
      const p = c?.meta.periods?.[b.dataset.period!];
      b.title = p ? `Statistics of the ${format("02d")(p.utc_hour)} UTC time steps` : "Statistics of all hours";
    }
    $("clim-download").hidden = !c?.meta.downloads?.length;
    if (c?.meta.downloads) {
      const total = c.meta.downloads.reduce((sum, d) => sum + d.bytes, 0);
      $("clim-download-label").textContent = `nc (${fmtBytes(total)})`;
    }
    $("diurnal-panel").hidden = !c;
    $("time-name").textContent = c ? "Month" : "Time";
    document.querySelector(".layout")!.classList.toggle("clim", !!c);
    const statGroup = $("stat");
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
          b.addEventListener("click", () => this.app.store.set({ stat }));
          group.append(b);
        }
        if (group.childElementCount) statGroup.append(group);
      }
    this.buildVariableSwitch();
    const info = $("info");
    info.innerHTML = "";
    const grid: [string, string] = ["Grid", `${data.nlat} × ${data.nlon} cells, ${data.nz} heights`];
    const rows: [string, string][] =
      data instanceof Cycle
        ? [...forecastInfo(data), grid, ...Object.entries(data.info)]
        : [["Climatology", "per calendar month"], grid, ...Object.entries(data.info)];
    for (const [k, v] of rows) {
      const dt = document.createElement("dt");
      dt.textContent = k;
      const dd = document.createElement("dd");
      dd.textContent = v;
      info.append(dt, dd);
    }
    // The texts of the page (content/) and the notes of the data, if any
    $("notes-live").hidden = !!c;
    $("notes-clim").hidden = !c;
    void renderNotes($("notes-data"), data.notes ? [new URL(data.notes, data.base).href] : []);
    if (this.hooked.has(data)) return;
    this.hooked.add(data);
    data.onStep((step) => {
      if (data !== this.data) return; // a dataset switched away from while loading
      if (step === this.s.step) {
        this.map();
        this.profile();
      }
      this.scheduleTimeHeight();
      this.status();
      this.csvButton();
    });
  }

  map() {
    const s = this.s;
    const { shownRange, shownArr, statFor, cmap, periodLabel, statName, fullLabel } = this.l;
    const { data } = this;
    const [lo, hi] = shownRange(s.variable, this.mapRange(s.variable, s.zi, s.colourPerHeight));
    const stat = statFor(s.variable);
    this.mapView.draw(shownArr(s.variable, data.field(s.variable, s.step, s.zi, stat)), cmap(s.variable), lo, hi);
    const atZ = data.profileVars.includes(s.variable) ? ` at ${formatHeight(data.z[s.zi])}` : "";
    const c = climOf(data);
    const hours = c && periodLabel(c) ? `, ${periodLabel(c)}` : "";
    const ofStat = stat ? `, ${statName(stat, s.variable).toLowerCase()}${hours}` : "";
    drawColorbar($("colorbar"), cmap(s.variable), [lo, hi], `${fullLabel(s.variable)}${ofStat}${atZ}`);
  }

  profile() {
    const s = this.s;
    const { data } = this;
    const { profileVar, statFor, fullLabel, stepLabel, periodLabel, statName, cellLabel, units, label, fmt, shown, shownArr, shownRange } = this.l; // fmt: skip
    const pv = profileVar(s);
    const c = climOf(data);
    const stat = pv && statFor(pv);
    $("profile-title").textContent = pv ? fullLabel(pv) : "Profile";
    let when = stepLabel(s.step);
    if (c && stat) {
      const hours = periodLabel(c) ? ` (${periodLabel(c)})` : "";
      when = `${when}${hours}, ${statName(stat, pv!).toLowerCase()}`;
    }
    $("profile-sub").textContent = s.cell >= 0 ? `${cellLabel(s.cell)} · ${when}` : "Click the map to select a point";
    const values = $("column-values");
    values.innerHTML = "";
    for (const name of data.columnVars) {
      const chip = document.createElement("span");
      chip.className = name === s.variable ? "chip active" : "chip";
      const u = units(name) === "1" ? "" : ` ${units(name)}`;
      chip.textContent = `${label(name)} ${fmt(name)(shown(name, data.value(name, s.step, 0, s.cell, statFor(name))))}${u}`;
      values.append(chip);
    }
    if (!pv || s.cell < 0) return drawLegend($("profile-legend"), []);
    // Context: the climatology (25th–75th, 5th–95th percentile, median), of the forecast's month behind a forecast
    const percentiles: [string, string][] = [["band-inner", "25th–75th percentile"], ["band", "5th–95th percentile"]];
    let bands: { z: number[]; lo: Float32Array; hi: Float32Array }[] = [];
    let reference: { z: number[]; values: Float32Array } | undefined;
    let xDomain = this.profileDomain(data, pv);
    if (c) {
      const band = (lo: string, hi: string) => ({ z: data.z, lo: data.profile(pv, s.step, s.cell, lo), hi: data.profile(pv, s.step, s.cell, hi) }); // fmt: skip
      bands = [band("p5", "p95"), band("p25", "p75")].filter((b) => b.lo && b.hi) as typeof bands;
      drawLegend($("profile-legend"), [["", statName(stat!, pv)], ...percentiles]);
    } else {
      const behind = this.climBehind(pv, s);
      if (behind) {
        ({ bands, reference } = behind);
        xDomain = [Math.min(xDomain[0], behind.domain[0]), Math.max(xDomain[1], behind.domain[1])];
      }
      drawLegend($("profile-legend"), [
        ["live", "Forecast"],
        ...(behind ? ([["dashed", `Climatology ${behind.month}: median`], ...percentiles] as [string, string][]) : []),
      ]);
    }
    this.profileView.draw({
      z: data.z,
      profile: shownArr(pv, data.profile(pv, s.step, s.cell, stat)),
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
  timeHeight(boxOnly = false) {
    const s = this.s;
    const { data } = this;
    const { profileVar, statFor, linear, periodLabel, cellLabel, label, statName, cmap, shownRange, fmt, fullLabel, stepLabel } = this.l; // fmt: skip
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
      const current = () => climOf(this.data) === c && this.s.diurnalKind === "violin";
      void loading(["th"], c.loadMonthViolins(linear)).then(
        () => current() && this.timeHeight(),
        (e) => (console.warn("Loading the violins of the annual cycle failed:", e), current() && this.timeHeight(true)),
      );
      return;
    }
    drawLegend($("th-legend"), c ? this.boxLegend(c, kind, c.columnVars) : []);
    const hours = c && periodLabel(c) ? ` (${periodLabel(c)})` : "";
    $("th-title").textContent = `${c ? "Annual cycle" : "Forecast"}${hours} at ${cellLabel(s.cell)}`;
    this.thView.draw({
      steps: data,
      name: pv,
      cell: s.cell,
      step: s.step,
      zi: s.zi,
      heightScale: s.heightScale,
      label: c ? `${label(pv)} (${statName(stat!, pv).toLowerCase()})` : label(pv),
      cmap: cmap(pv),
      range: shownRange(pv, this.globalRange(pv)),
      fmt: fmt(pv),
      tf: linear(pv) ? (v) => 10 ** v : undefined,
      columns: data.columnVars.map((name) => ({
        name,
        label: fullLabel(name),
        fmt: fmt(name),
        tf: linear(name) ? (v: number) => 10 ** v : undefined,
        boxes: c && this.shownBoxes(name, Object.fromEntries(c.stats(name).map((k) => [k, c.series(name, s.cell, k)]))),
        violins: c && kind === "violin" ? this.shownViolins(name, c.monthViolin(name, s.cell, linear(name))) : undefined,
      })),
      stepLabel,
      from: this.app.firstStep,
      showZ: data.profileVars.includes(s.variable),
      stat: c ? s.stat : undefined,
      band: c ? ["p25", "p75"] : undefined,
      months: !!c,
    });
    drawColorbar($("th-colorbar"), cmap(pv), shownRange(pv, this.globalRange(pv)), fullLabel(pv));
  }

  diurnal() {
    const s = this.s;
    const c = climOf(this.data);
    if (!c || s.cell < 0) return;
    $("diurnal-title").textContent = `Diurnal cycle in ${fmtMonth(c.times[s.step])} at ${this.l.cellLabel(s.cell)}`;
    const kind = c.violinVars.length ? s.diurnalKind : "box";
    $("diurnal-kind").hidden = !c.violinVars.length;
    for (const b of $("diurnal-kind").querySelectorAll<HTMLButtonElement>("button"))
      b.setAttribute("aria-pressed", String(b.dataset.kind === kind));
    drawLegend($("diurnal-legend"), this.boxLegend(c, kind, c.diurnalVars, (n) => c.variables[n].diurnal?.stats));
    // Drawn once the profiles of the cell (and the violins of the month) are loaded (at once if they are), the previous
    // plot stays until then
    const { step, cell } = s;
    const pv = this.l.profileVar(s);
    const current = () => climOf(this.data) === c && this.s.step === step && this.s.cell === cell;
    const loads = Promise.all([
      pv && c.hasDiurnalProfiles(pv) ? c.loadDiurnalProfiles(pv, cell) : undefined,
      kind === "violin" ? c.loadViolins(step, this.l.linear) : undefined,
    ]);
    void loading(["diurnal"], loads).then(
      () => current() && this.drawDiurnal(c),
      (e) => (console.warn("Loading the diurnal cycle failed:", e), current() && this.drawDiurnal(c)),
    );
  }
  /** The diurnal cycle of the month and cell selected: the profile variable over the hours, the column variables as
   * box plots or violins below. */
  private drawDiurnal(c: Climatology) {
    const s = this.s;
    const { profileVar, statFor, label, statName, cmap, shownRange, fmt, linear, fullLabel } = this.l;
    const pv = profileVar(s);
    if (!pv) return;
    const stat = statFor(pv)!;
    const kind = c.violinVars.length ? s.diurnalKind : "box";
    const hours = c.meta.hours;
    this.daySteps = {
      times: hours.map((h) => new Date(Date.UTC(2001, 0, 1, h))),
      z: c.z,
      nz: c.nz,
      profile: (name, h, cell, stat) => c.diurnalProfile(name, s.step, h, cell, stat),
      series: () => new Float32Array(hours.length).fill(NaN),
    };
    this.dayView.draw({
      steps: this.daySteps,
      name: pv,
      cell: s.cell,
      step: -1,
      zi: s.zi,
      heightScale: s.heightScale,
      label: `${label(pv)} (${statName(stat, pv).toLowerCase()})`,
      cmap: cmap(pv),
      range: shownRange(pv, this.globalRange(pv)),
      fmt: fmt(pv),
      tf: linear(pv) ? (v) => 10 ** v : undefined,
      columns: c.diurnalVars.map((name) => ({
        name,
        label: fullLabel(name),
        fmt: fmt(name),
        boxes: this.shownBoxes(name, c.diurnal(name, s.step, s.cell)),
        violins: kind === "violin" ? this.shownViolins(name, c.violin(name, s.step, s.cell, linear(name))) : undefined,
      })),
      stepLabel: (h) => `${fmtMonth(c.times[s.step])}, ${format("02d")(hours[h])}:00 UTC`,
      stat,
      showZ: this.data.profileVars.includes(s.variable),
      hours: true,
    });
    drawColorbar($("diurnal-colorbar"), cmap(pv), shownRange(pv, this.globalRange(pv)), fullLabel(pv));
  }
  /** Box statistics per step as shown; shown linearly, the mean is that of the linear values (lmean) if there. */
  private shownBoxes(name: string, stats: Record<string, Float32Array> | undefined): BoxStats | undefined {
    if (!stats) return undefined;
    const boxes = Object.fromEntries(Object.entries(stats).map(([k, a]) => [k, this.l.shownArr(name, a)])) as BoxStats;
    if (boxes.lmean && this.l.linear(name)) boxes.mean = boxes.lmean;
    return boxes;
  }
  /** Legend of box plots or violins of `names`; `stats`: their statistics (default: the monthly ones). */
  private boxLegend(c: Climatology, kind: "box" | "violin", names: string[], stats: (n: string) => string[] | undefined = (n) => c.stats(n)): [string, string][] { // fmt: skip
    // Shown linearly without lmean, the mean is the geometric mean
    const geometric = names.filter((n) => this.l.linear(n) && !stats(n)?.includes("lmean")).map(this.l.label);
    const mean = geometric.length ? `Mean (geometric of ${geometric.join(", ")})` : "Mean";
    return kind === "violin"
      ? [["violin", "Distribution"], ["box", "25th–75th percentile"], ["", "Median"], ["dot", mean]]
      : [["box", "25th–75th percentile"], ["whisker", "5th–95th percentile"], ["", "Median"], ["dot", mean]];
  }
  /** Violins of a log₁₀ variable shown linearly: those of the linear values if the data have them, else the log₁₀
   * densities per linear unit (divided by 10^value), scaled to a maximum of 1 again. */
  private shownViolins(name: string, v: (Violins & { linear: boolean }) | undefined): Violins | undefined {
    if (!v || !this.l.linear(name) || v.linear) return v;
    const x = v.x.map((e) => 10 ** e);
    const density = v.density.map((d) => {
      const per = d.map((p, i) => p / x[i]);
      const max = per.reduce((m, p) => (p > m ? p : m), 0);
      return max > 0 ? per.map((p) => p / max) : per;
    });
    return { x, density };
  }
  private scheduleTimeHeight() {
    if (!this.thTimer) this.thTimer = window.setTimeout(() => ((this.thTimer = 0), this.timeHeight()), 150);
  }

  controls() {
    const s = this.s;
    const { data } = this;
    const { label, vc, statName, statButton, statFor } = this.l;
    const timeInput = $<HTMLInputElement>("time");
    const heightInput = $<HTMLInputElement>("height");
    const logValues = $<HTMLInputElement>("log-values");
    timeInput.min = String(this.app.firstStep);
    timeInput.value = String(s.step);
    $("time-label").textContent = this.l.stepLabel(s.step);
    heightInput.value = String(s.zi);
    heightInput.disabled = !data.nz;
    $("height-label").textContent = data.nz ? formatHeight(data.z[s.zi]) : "–";
    // Column-integrated variables on the map: no height to choose (the profile's is picked in its plots)
    $("height-group").hidden = !data.profileVars.includes(s.variable);
    fill(timeInput);
    fill(heightInput);
    $("play-icon").setAttribute("d", s.playing ? ICON_PAUSE : ICON_PLAY);
    $("play").setAttribute("aria-label", s.playing ? "Pause" : "Play");
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
    const latest = latestCycle(this.app.index);
    const newer = $("newer");
    newer.hidden = !(data instanceof Cycle) || data.id === latest;
    newer.title = `A newer forecast is available (${fmtCycle(latest)}): show it`;
    this.live();
    this.csvButton();
    for (const b of $("mode-tabs").querySelectorAll("button"))
      b.setAttribute("aria-selected", String(b.dataset.mode === s.mode));
    const c = climOf(data);
    for (const b of $("period").querySelectorAll("button"))
      b.setAttribute("aria-pressed", String(b.dataset.period === s.period));
    if (c) {
      for (const b of $("stat").querySelectorAll<HTMLButtonElement>("button")) {
        const has = c.stats(s.variable).includes(b.dataset.stat!);
        b.disabled = !has;
        const name = statName(b.dataset.stat!, s.variable);
        b.textContent = statButton(b.dataset.stat!, b.dataset.text!, s.variable);
        b.title = has ? name : `${name}: not available for ${label(s.variable)}`;
        b.setAttribute("aria-pressed", String(b.dataset.stat === statFor(s.variable)));
      }
    }
  }

  /** The CSV of the profile on screen: the climatology only, usable once its month is loaded. */
  private csvButton() {
    const s = this.s;
    const b = $<HTMLButtonElement>("profile-csv");
    const c = climOf(this.data);
    b.hidden = !c || s.cell < 0 || !this.l.profileVar(s);
    if (b.hidden) return;
    b.disabled = !c!.hasStep(s.step) || c!.period !== s.period;
    b.title = b.disabled
      ? "Loading the data of this view"
      : "Download this profile as a CSV file: this month, point and period, the statistics shown here";
  }

  /** The live badge: the newest forecast run at the current hour. */
  live() {
    const { data } = this;
    $("live-badge").hidden = !(
      data instanceof Cycle &&
      data.id === latestCycle(this.app.index) &&
      data.times[this.s.step].getTime() === currentHour()
    );
  }

  status() {
    const { data, app } = this;
    const total = data.times.length - app.firstStep;
    const n = data.loadedCount(app.firstStep);
    const bar = $("progress");
    bar.hidden = n >= total;
    bar.title = `Loading ${climOf(data) ? "months" : "lead times"}: ${n}/${total}`;
    (bar.firstElementChild as HTMLElement).style.width = `${(100 * n) / total}%`;
  }

  /** Draws what depends on the state keys `changed`. */
  update(changed: Set<Key>) {
    const s = this.s;
    const any = (...keys: Key[]) => keys.some((k) => changed.has(k));
    if (any("step")) void loading(["map", "profile"], this.data.loadStep(s.step));
    if (any("variable", "step", "zi", "colourPerHeight", "stat", "logValues")) this.map();
    if (any("cell")) this.mapView.setSelection(s.cell);
    if (any("variable", "step", "zi", "cell", "heightScale", "stat", "logValues")) this.profile();
    if (any("variable", "cell", "heightScale", "stat", "logValues", "diurnalKind")) this.timeHeight();
    else if (any("step", "zi")) this.thView.setCursor(this.data, s.step, s.zi);
    if (any("variable", "step", "cell", "heightScale", "stat", "diurnalKind", "logValues")) this.diurnal();
    else if (any("zi") && this.daySteps) this.dayView.setCursor(this.daySteps, -1, s.zi);
    this.controls();
  }

  all() {
    this.map();
    this.mapView.setSelection(this.s.cell);
    this.profile();
    this.timeHeight();
    this.diurnal();
    this.controls();
    this.status();
  }

  /** The plots again, at a new size. */
  plots() {
    this.map();
    this.profile();
    this.timeHeight();
    this.diurnal();
  }
}
