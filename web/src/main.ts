import "@fontsource/roboto/400.css";
import "@fontsource/roboto/500.css";
import "@fontsource/roboto/700.css";
import "./style.css";
import { format } from "d3-format";
import { utcFormat } from "d3-time-format";
import { Colormap, drawColorbar } from "./colormap";
import { loadConfig } from "./config";
import { Cycle, loadIndex, nearestIndex } from "./data";
import { MapView } from "./map";
import { renderNotes } from "./notes";
import { formatHeight, ProfileView, TimeHeightView } from "./plots";
import { type HashState, parseHash, resolve, type State, Store, toHash } from "./state";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const fmtTime = utcFormat("%a %d %b %Y %H:%M UTC");
const fmtLatLon = (lat: number, lon: number) =>
  `${Math.abs(lat).toFixed(2)}°${lat >= 0 ? "N" : "S"} ${Math.abs(lon).toFixed(2)}°${lon >= 0 ? "E" : "W"}`;
const fmtLead = (h: number) => `+${format("~r")(h)} h`;
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
  const hash = parseHash(location.hash);
  let cycle = await Cycle.open(config.dataUrl, hash.cycle && index.cycles.includes(hash.cycle) ? hash.cycle : (index.latest ?? index.cycles[0])); // fmt: skip

  // Presentation per variable: config.json first, then the data
  const vc = (name: string) => config.variables[name] ?? {};
  const label = (name: string) => vc(name).label ?? cycle.meta.variables[name]?.long_name ?? name;
  const units = (name: string) => vc(name).units ?? cycle.meta.variables[name]?.units ?? "";
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
  const globalRange = (name: string): [number, number] => {
    const v = cycle.meta.variables[name];
    return vc(name).range ?? v.display_range ?? v.valid_range ?? [0, 1];
  };
  const mapRange = (name: string, zi: number, perHeight: boolean): [number, number] => {
    const v = cycle.meta.variables[name];
    if (perHeight && !vc(name).range && v.display_range_z?.[zi]) return v.display_range_z[zi];
    return globalRange(name);
  };
  const profileVar = (s: State) => (cycle.profileVars.includes(s.variable) ? s.variable : cycle.profileVars[0]);

  const fallback = (c: Cycle) => {
    const names = Object.keys(c.meta.variables);
    const d = config.defaults;
    const cell = d.lat !== undefined && d.lon !== undefined ? c.nearestCell(d.lat, d.lon) : -1;
    return {
      variable: d.variable && names.includes(d.variable) ? d.variable : names[0],
      lead: 0,
      zi: c.nz ? nearestIndex(c.z, d.z ?? 100) : 0,
      cell: cell >= 0 ? cell : c.nearestCell(c.meta.lat[c.nlat >> 1], c.meta.lon[c.nlon >> 1]),
    };
  };
  const store = new Store({
    cycle: cycle.id,
    ...resolve(hash, cycle, fallback(cycle)),
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
      const v = cycle.value(s.variable, s.lead, s.zi, cell);
      const lat = cycle.meta.lat[Math.floor(cell / cycle.nlon)];
      const lon = cycle.meta.lon[cell % cycle.nlon];
      tooltip.textContent = `${fmtLatLon(lat, lon)}: ${fmt(s.variable)(v)} ${units(s.variable) === "1" ? "" : units(s.variable)}`; // fmt: skip
      tooltip.style.transform = `translate(${point.x + 14}px, ${point.y + 14}px)`;
    },
  );
  const profileView = new ProfileView($("profile"), (zi) => store.set({ zi }));
  const thView = new TimeHeightView(
    $("timeheight"),
    (lead, zi) => store.set(zi === undefined ? { lead, playing: false } : { lead, zi, playing: false }),
    (text) => ($("th-hover").textContent = text),
  );

  // Controls
  const timeInput = $<HTMLInputElement>("time");
  const heightInput = $<HTMLInputElement>("height");
  const play = $<HTMLButtonElement>("play");
  const logHeight = $<HTMLInputElement>("log-height");
  const colourZ = $<HTMLInputElement>("colour-z");
  const speed = $<HTMLSelectElement>("speed");
  const cycleSelect = $<HTMLSelectElement>("cycle-select");
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

  function buildVariableSwitch() {
    const el = $("var-switch");
    el.innerHTML = "";
    for (const name of Object.keys(cycle.meta.variables)) {
      const b = document.createElement("button");
      b.type = "button";
      b.dataset.name = name;
      b.textContent = label(name);
      b.title = cycle.meta.variables[name].long_name ?? name;
      b.addEventListener("click", () => store.set({ variable: name }));
      el.append(b);
    }
  }

  function setupCycle() {
    timeInput.max = String(cycle.times.length - 1);
    heightInput.max = String(Math.max(0, cycle.nz - 1));
    cycleSelect.value = cycle.id;
    buildVariableSwitch();
    const info = $("info");
    info.innerHTML = "";
    const lh = cycle.meta.lead_hours;
    const rows: [string, string][] = [
      ["Initialised", fmtTime(new Date(cycle.meta.cycle))],
      ["Lead times", `${fmtLead(lh[0])} to ${fmtLead(lh.at(-1)!)} (${lh.length})`],
      ["Grid", `${cycle.nlat} × ${cycle.nlon} cells, ${cycle.nz} heights`],
      ...Object.entries(cycle.meta.info ?? {}),
    ];
    for (const [k, v] of rows) {
      const dt = document.createElement("dt");
      dt.textContent = k;
      const dd = document.createElement("dd");
      dd.textContent = v;
      info.append(dt, dd);
    }
    const notes = [...(config.notes ? [new URL(config.notes, location.href).href] : [])];
    if (cycle.meta.notes) notes.push(new URL(cycle.meta.notes, cycle.base).href);
    void renderNotes($("notes"), notes);
    const c = cycle;
    c.onLead((lead) => {
      if (c !== cycle) return; // a cycle switched away from while loading
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
    mapView.draw(cycle.field(s.variable, s.lead, s.zi), cmap(s.variable), lo, hi);
    const atZ = cycle.profileVars.includes(s.variable) ? ` at ${formatHeight(cycle.z[s.zi])}` : "";
    drawColorbar($("colorbar"), cmap(s.variable), [lo, hi], `${fullLabel(s.variable)}${atZ}`);
  }

  function renderProfile() {
    const s = st();
    const pv = profileVar(s);
    const i = Math.floor(s.cell / cycle.nlon);
    const j = s.cell % cycle.nlon;
    $("profile-title").textContent = pv ? fullLabel(pv) : "Profile";
    $("profile-sub").textContent = s.cell >= 0 ? `${fmtLatLon(cycle.meta.lat[i], cycle.meta.lon[j])} · ${fmtTime(cycle.times[s.lead])} (${fmtLead(cycle.meta.lead_hours[s.lead])})` : "Click the map to select a point"; // fmt: skip
    const values = $("column-values");
    values.innerHTML = "";
    for (const name of cycle.columnVars) {
      const chip = document.createElement("span");
      chip.className = name === s.variable ? "chip active" : "chip";
      const u = units(name) === "1" ? "" : ` ${units(name)}`;
      chip.textContent = `${label(name)} ${fmt(name)(cycle.value(name, s.lead, 0, s.cell))}${u}`;
      values.append(chip);
    }
    if (!pv || s.cell < 0) return;
    const v = cycle.meta.variables[pv];
    profileView.draw({
      cycle,
      name: pv,
      lead: s.lead,
      cell: s.cell,
      zi: s.zi,
      heightScale: s.heightScale,
      xDomain: v.valid_range ?? globalRange(pv),
      xLabel: fullLabel(pv),
      fmt: fmt(pv),
    });
  }

  function renderTimeHeight() {
    const s = st();
    const pv = profileVar(s);
    if (!pv || s.cell < 0) return;
    const i = Math.floor(s.cell / cycle.nlon);
    const j = s.cell % cycle.nlon;
    $("th-title").textContent = `${label(pv)} at ${fmtLatLon(cycle.meta.lat[i], cycle.meta.lon[j])}`;
    thView.draw({
      cycle,
      name: pv,
      cell: s.cell,
      lead: s.lead,
      zi: s.zi,
      heightScale: s.heightScale,
      cmap: cmap(pv),
      range: globalRange(pv),
      fmt: fmt(pv),
      columns: cycle.columnVars.map((name) => ({ name, label: fullLabel(name), fmt: fmt(name) })),
    });
    drawColorbar($("th-colorbar"), cmap(pv), globalRange(pv), fullLabel(pv));
  }
  let thTimer = 0;
  function scheduleTimeHeight() {
    if (!thTimer) thTimer = window.setTimeout(() => ((thTimer = 0), renderTimeHeight()), 150);
  }

  function renderControls() {
    const s = st();
    timeInput.value = String(s.lead);
    $("time-label").textContent = `${fmtTime(cycle.times[s.lead])} (${fmtLead(cycle.meta.lead_hours[s.lead])})`;
    heightInput.value = String(s.zi);
    heightInput.disabled = !cycle.nz;
    $("height-label").textContent = cycle.nz ? formatHeight(cycle.z[s.zi]) : "–";
    $("height-group").classList.toggle("secondary", !cycle.profileVars.includes(s.variable));
    $("height-group").title = cycle.profileVars.includes(s.variable) ? "" : "Column value on the map: the height applies to the profile";
    fill(timeInput);
    fill(heightInput);
    $("play-icon").setAttribute("d", s.playing ? ICON_PAUSE : ICON_PLAY);
    play.setAttribute("aria-label", s.playing ? "Pause" : "Play");
    for (const b of $("var-switch").querySelectorAll("button"))
      b.setAttribute("aria-pressed", String(b.dataset.name === s.variable));
    colourZ.disabled = !cycle.profileVars.includes(s.variable);
  }

  function renderStatus() {
    const n = cycle.loadedCount;
    const bar = $("progress");
    bar.hidden = n >= cycle.times.length;
    bar.title = `Loading lead times: ${n}/${cycle.times.length}`;
    (bar.firstElementChild as HTMLElement).style.width = `${(100 * n) / cycle.times.length}%`;
  }

  // Playback: waits for lead times that are not loaded yet
  let playTimer = 0;
  function schedulePlay() {
    clearTimeout(playTimer);
    if (!st().playing) return;
    playTimer = window.setTimeout(async () => {
      const next = (st().lead + 1) % cycle.times.length;
      await cycle.loadLead(next);
      if (st().playing) {
        store.set({ lead: next });
        schedulePlay();
      }
    }, config.playIntervalMs * +speed.value);
  }

  store.subscribe((s, ch) => {
    const any = (...keys: (keyof State)[]) => keys.some((k) => ch.has(k));
    if (any("lead")) void cycle.loadLead(s.lead);
    if (any("variable", "lead", "zi", "colourPerHeight")) renderMap();
    if (any("cell")) mapView.setSelection(s.cell);
    if (any("variable", "lead", "zi", "cell", "heightScale")) renderProfile();
    if (any("variable", "cell", "heightScale")) renderTimeHeight();
    else if (any("lead", "zi")) thView.setCursor(cycle, s.lead, s.zi);
    renderControls();
    if (any("playing")) schedulePlay();
    history.replaceState(null, "", toHash(s, cycle));
  });

  // Cycles: keep the physical view (lead hours, height, location) when switching
  const physical = (): HashState => {
    const s = st();
    return {
      variable: s.variable,
      leadHours: cycle.meta.lead_hours[s.lead],
      z: cycle.z[s.zi],
      lat: s.cell >= 0 ? cycle.meta.lat[Math.floor(s.cell / cycle.nlon)] : undefined,
      lon: s.cell >= 0 ? cycle.meta.lon[s.cell % cycle.nlon] : undefined,
    };
  };
  async function switchCycle(id: string, h: HashState) {
    store.set({ playing: false });
    cycle = await Cycle.open(config.dataUrl, id);
    cmaps.clear();
    setupCycle();
    await mapView.setCycle(cycle);
    const r = resolve(h, cycle, fallback(cycle));
    store.state = { ...st(), cycle: id, ...r };
    await cycle.loadLead(r.lead);
    renderAll();
    void cycle.loadAll(r.lead);
  }
  function renderAll() {
    const s = st();
    renderMap();
    mapView.setSelection(s.cell);
    renderProfile();
    renderTimeHeight();
    renderControls();
    renderStatus();
    history.replaceState(null, "", toHash(s, cycle));
  }

  // Links in the notes and edits of the URL
  addEventListener("hashchange", () => {
    const h = parseHash(location.hash);
    if (h.cycle && h.cycle !== cycle.id && index.cycles.includes(h.cycle)) return void switchCycle(h.cycle, { ...physical(), ...h }); // fmt: skip
    store.set({ ...resolve(h, cycle, { ...st() }), playing: false });
  });

  addEventListener("keydown", (e) => {
    const t = e.target as HTMLElement;
    if (t.tagName === "SELECT" || (t.tagName === "INPUT" && (t as HTMLInputElement).type !== "checkbox")) return;
    const s = st();
    const n = cycle.times.length;
    const step: Record<string, () => Partial<State>> = {
      " ": () => ({ playing: !s.playing }),
      ArrowRight: () => ({ lead: (s.lead + 1) % n, playing: false }),
      ArrowLeft: () => ({ lead: (s.lead - 1 + n) % n, playing: false }),
      ArrowUp: () => ({ zi: Math.min(cycle.nz - 1, s.zi + 1) }),
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
    });
  };
  new ResizeObserver(onResize).observe($("profile"));
  new ResizeObserver(onResize).observe($("timeheight"));

  setupCycle();
  await mapView.setCycle(cycle);
  await cycle.loadLead(st().lead);
  renderAll();
  void cycle.loadAll(st().lead);
}

main().catch((e: unknown) => {
  console.error(e);
  const el = $("error");
  el.hidden = false;
  el.textContent = `Could not load the forecast: ${e instanceof Error ? e.message : String(e)}`;
});

