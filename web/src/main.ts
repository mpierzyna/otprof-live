import "@fontsource/roboto/400.css";
import "@fontsource/roboto/500.css";
import "@fontsource/roboto/700.css";
import "./style.css";
import { format } from "d3-format";
import { utcFormat } from "d3-time-format";
import { Colormap, drawColorbar } from "./colormap";
import { loadConfig } from "./config";
import { Climatology, Cycle, type Dataset, loadIndex, nearestIndex } from "./data";
import { MapView } from "./map";
import { renderNotes } from "./notes";
import { type BoxStats, DiurnalView, formatHeight, ProfileView, TimeHeightView } from "./plots";
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
/** The keys of `h` that are set (so that spreading it does not clear others). */
const defined = (h: HashState): HashState => Object.fromEntries(Object.entries(h).filter(([, v]) => v !== undefined));
const ICON_PLAY = "M8 5v14l11-7z";
const ICON_PAUSE = "M6 19h4V5H6v14zm8-14v14h4V5h-4z";
const fill = (input: HTMLInputElement) =>
  input.style.setProperty("--pct", `${(100 * +input.value) / Math.max(1, +input.max)}%`);

async function main() {
  const config = await loadConfig();
  document.title = config.title;
  $("title").textContent = config.title;
  $("subtitle").textContent = config.subtitle ?? "";
  if (config.disclaimer)
    void renderNotes($("disclaimer-text"), [new URL(config.disclaimer, location.href).href]).then(
      (any) => ($("disclaimer").hidden = !any),
    );
  const index = await loadIndex(config.dataUrl);
  const climUrl = index.climatology ? new URL(index.climatology, config.dataUrl).href : undefined;
  const hash = parseHash(location.hash);

  // The forecast cycle and the climatology are kept once loaded; `data` is the one shown
  let cycle: Cycle | undefined;
  let clim: Climatology | undefined;
  const openCycle = async (id: string) => (cycle = await Cycle.open(config.dataUrl, id));
  const openClim = async () => (clim ??= await Climatology.open(climUrl!));
  const firstCycle = hash.cycle && index.cycles.includes(hash.cycle) ? hash.cycle : (index.latest ?? index.cycles[0]);
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
  /** Profile axis: the data range of a forecast, the 5th to 95th percentile range of the climatology. */
  const profileDomain = (name: string): [number, number] => {
    const v = data.variables[name];
    const [p5, p95] = [v.display_ranges?.p5, v.display_ranges?.p95];
    if (p5 && p95) return [p5[0], p95[1]];
    return v.valid_range ?? globalRange(name);
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
      lead: cl ? nearestIndex(cl.meta.months, new Date().getUTCMonth() + 1) : 0, // climatology: this month
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
    heightScale: config.heightScale,
    colourPerHeight: config.colourPerHeight,
  });
  const st = () => store.state;

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
    (text) => ($("th-hover").textContent = text),
  );
  const diurnalView = new DiurnalView($("diurnal"));

  // Controls
  const timeInput = $<HTMLInputElement>("time");
  const heightInput = $<HTMLInputElement>("height");
  const play = $<HTMLButtonElement>("play");
  const logHeight = $<HTMLInputElement>("log-height");
  const colourZ = $<HTMLInputElement>("colour-z");
  const speed = $<HTMLSelectElement>("speed");
  const cycleSelect = $<HTMLSelectElement>("cycle-select");
  const statSelect = $<HTMLSelectElement>("stat");
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
  for (const id of index.cycles) cycleSelect.add(new Option(id, id));
  cycleSelect.addEventListener("change", () => switchCycle(cycleSelect.value, physical()));
  statSelect.addEventListener("change", () => store.set({ stat: statSelect.value }));
  $("mode-tabs").hidden = !climUrl;
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
    if (c && !statSelect.options.length) for (const stat of c.meta.stats) statSelect.add(new Option(statLabel(stat), stat));
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
    if (!pv || s.cell < 0) return;
    // Context: the range over the forecast, the 5th–95th and 25th–75th percentiles of the climatology
    const band = (lo: string, hi: string) => [data.profile(pv, s.lead, s.cell, lo), data.profile(pv, s.lead, s.cell, hi)]; // fmt: skip
    const bands = c
      ? [band("p5", "p95"), band("p25", "p75")].filter((b): b is [Float32Array, Float32Array] => !!b[0] && !!b[1])
      : [data.envelope(pv, s.cell)];
    profileView.draw({
      z: data.z,
      profile: data.profile(pv, s.lead, s.cell, stat),
      bands,
      zi: s.zi,
      heightScale: s.heightScale,
      xDomain: profileDomain(pv),
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
    diurnalView.draw(
      c.meta.hours,
      c.diurnalVars.map((name) => ({
        label: fullLabel(name),
        fmt: fmt(name),
        boxes: c.diurnal(name, s.lead, s.cell) as BoxStats | undefined,
      })),
    );
  }
  let thTimer = 0;
  function scheduleTimeHeight() {
    if (!thTimer) thTimer = window.setTimeout(() => ((thTimer = 0), renderTimeHeight()), 150);
  }

  function renderControls() {
    const s = st();
    timeInput.value = String(s.lead);
    $("time-label").textContent = stepLabel(s.lead);
    heightInput.value = String(s.zi);
    heightInput.disabled = !data.nz;
    $("height-label").textContent = data.nz ? formatHeight(data.z[s.zi]) : "–";
    $("height-group").classList.toggle("secondary", !data.profileVars.includes(s.variable));
    $("height-group").title = data.profileVars.includes(s.variable) ? "" : "Column value on the map: the height applies to the profile";
    fill(timeInput);
    fill(heightInput);
    $("play-icon").setAttribute("d", s.playing ? ICON_PAUSE : ICON_PLAY);
    play.setAttribute("aria-label", s.playing ? "Pause" : "Play");
    for (const b of $("var-switch").querySelectorAll("button"))
      b.setAttribute("aria-pressed", String(b.dataset.name === s.variable));
    colourZ.disabled = !data.profileVars.includes(s.variable);
    for (const b of $("mode-tabs").querySelectorAll("button"))
      b.setAttribute("aria-selected", String(b.dataset.mode === s.mode));
    const c = climOf(data);
    if (c) {
      statSelect.value = s.stat;
      for (const o of statSelect.options) o.disabled = !c.stats(s.variable).includes(o.value);
    }
  }

  function renderStatus() {
    const n = data.loadedCount;
    const bar = $("progress");
    bar.hidden = n >= data.times.length;
    bar.title = `Loading ${climOf(data) ? "months" : "lead times"}: ${n}/${data.times.length}`;
    (bar.firstElementChild as HTMLElement).style.width = `${(100 * n) / data.times.length}%`;
  }

  // Playback: waits for lead times that are not loaded yet
  let playTimer = 0;
  function schedulePlay() {
    clearTimeout(playTimer);
    if (!st().playing) return;
    playTimer = window.setTimeout(async () => {
      const next = (st().lead + 1) % data.times.length;
      await data.loadStep(next);
      if (st().playing) {
        store.set({ lead: next });
        schedulePlay();
      }
    }, config.playIntervalMs * +speed.value);
  }

  store.subscribe((s, ch) => {
    const any = (...keys: (keyof State)[]) => keys.some((k) => ch.has(k));
    if (any("lead")) void data.loadStep(s.lead);
    if (any("variable", "lead", "zi", "colourPerHeight", "stat")) renderMap();
    if (any("cell")) mapView.setSelection(s.cell);
    if (any("variable", "lead", "zi", "cell", "heightScale", "stat")) renderProfile();
    if (any("variable", "cell", "heightScale", "stat")) renderTimeHeight();
    else if (any("lead", "zi")) thView.setCursor(data, s.lead, s.zi);
    if (any("lead", "cell")) renderDiurnal();
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
  async function switchTo(next: Dataset, h: HashState) {
    store.set({ playing: false });
    data = next;
    cmaps.clear();
    setupData();
    await mapView.setCycle(data);
    const r = resolve(h, data, fallback(data));
    store.state = { ...st(), mode: climOf(data) ? "clim" : "live", ...(data instanceof Cycle && { cycle: data.id }), ...r }; // fmt: skip
    await data.loadStep(r.lead);
    renderAll();
    void data.loadAll(r.lead);
  }
  async function switchCycle(id: string, h: HashState) {
    await switchTo(await openCycle(id), h);
  }
  /** The climatology opens at the month of the forecast time shown; the forecast at the lead time it was left at. */
  async function switchMode(mode: Mode, extra: HashState = {}) {
    if (mode === st().mode || (mode === "clim" && !climUrl)) return;
    const h = physical();
    if (mode === "clim") {
      liveLeadHours = h.leadHours;
      if (data instanceof Cycle) h.month = data.times[st().lead].getUTCMonth() + 1;
      return switchTo(await openClim(), { ...h, ...defined(extra) });
    }
    const id = extra.cycle && index.cycles.includes(extra.cycle) ? extra.cycle : st().cycle;
    const next = cycle?.id === id ? cycle : await openCycle(id);
    await switchTo(next, { ...h, leadHours: liveLeadHours, ...defined(extra) });
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
    if (h.mode && h.mode !== st().mode) return void switchMode(h.mode, h);
    if (data instanceof Cycle && h.cycle && h.cycle !== data.id && index.cycles.includes(h.cycle)) return void switchCycle(h.cycle, { ...physical(), ...defined(h) }); // fmt: skip
    store.set({ ...resolve(h, data, { ...st() }), playing: false });
  });

  addEventListener("keydown", (e) => {
    const t = e.target as HTMLElement;
    if (t.tagName === "SELECT" || (t.tagName === "INPUT" && (t as HTMLInputElement).type !== "checkbox")) return;
    const s = st();
    const n = data.times.length;
    const step: Record<string, () => Partial<State>> = {
      " ": () => ({ playing: !s.playing }),
      ArrowRight: () => ({ lead: (s.lead + 1) % n, playing: false }),
      ArrowLeft: () => ({ lead: (s.lead - 1 + n) % n, playing: false }),
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
  void data.loadAll(st().lead);
}

main().catch((e: unknown) => {
  console.error(e);
  const el = $("error");
  el.hidden = false;
  el.textContent = `Could not load the data: ${e instanceof Error ? e.message : String(e)}`;
});

