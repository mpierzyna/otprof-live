import "@fontsource-variable/inter";
import "./style.css";
import { loadConfig } from "./config";
import { Climatology, Cycle, type Dataset, latestCycle, loadIndex, nearestIndex } from "./data";
import { Downloads, fmtBytes } from "./download";
import { climOf, fmtCycle, Labels } from "./labels";
import { currentHour, loading, PANELS, Renderer, TH_HINT } from "./render";
import { type App, type HashState, type Mode, parseHash, parseLog, resolve, type State, Store, toHash } from "./state";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
/** The keys of `h` that are set (so that spreading it does not clear others). */
const defined = (h: HashState): HashState => Object.fromEntries(Object.entries(h).filter(([, v]) => v !== undefined));
const SPEEDS: [number, string][] = [[2, "0.5×"], [1, "1×"], [0.5, "2×"], [0.25, "4×"]]; // interval factor, label
const DISCLAIMER_KEY = "otprof-live.disclaimer"; // localStorage: "closed" once the banner was collapsed
const INDEX_POLL_MS = 10 * 60 * 1000; // new forecast runs: checked every 10 min
const LIVE_CHECK_MS = 30 * 1000; // the live badge: goes off soon after the hour turns
/** Index of the first time from the current hour (floored) on, -1 if all are earlier. */
function futureStep(times: Date[]): number {
  const hour = currentHour();
  return times.findIndex((t) => t.getTime() >= hour);
}
/** The step of the current hour: the first time from it on, or the last time if all are earlier. */
function nowStep(times: Date[]): number {
  const k = futureStep(times);
  return k < 0 ? times.length - 1 : k;
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
  const index = await loadIndex(config.dataUrl);
  const climUrl = index.climatology ? new URL(index.climatology, config.dataUrl).href : undefined;
  const hash = parseHash(location.hash);

  // The forecast cycle and the climatology are kept once loaded; `app.data` is the one shown
  let cycle: Cycle | undefined;
  const openCycle = async (id: string) => (cycle = await Cycle.open(config.dataUrl, id));
  let climLoad: Promise<Climatology> | undefined;
  const openClim = () => (climLoad ??= Climatology.open(climUrl!).then((c) => (app.clim = c)));
  const firstCycle = hash.cycle && index.cycles.includes(hash.cycle) ? hash.cycle : latestCycle(index);
  /** Lead hours shown when the forecast was left for the climatology */
  let liveLeadHours: number | undefined;

  const fallback = (c: Dataset) => {
    const names = Object.keys(c.variables);
    const d = config.defaults;
    const cell = d.lat !== undefined && d.lon !== undefined ? c.nearestCell(d.lat, d.lon) : -1;
    const cl = climOf(c);
    return {
      variable: d.variable && names.includes(d.variable) ? d.variable : names[0],
      // Now: the climatology of this month, the forecast from the current hour on (or its last time if all is past)
      step: cl ? nearestIndex(cl.meta.months, new Date().getUTCMonth() + 1) : nowStep(c.times),
      zi: c.nz ? nearestIndex(c.z, d.z ?? 100) : 0,
      cell: cell >= 0 ? cell : c.nearestCell(c.lat[c.nlat >> 1], c.lon[c.nlon >> 1]),
      stat: "median",
    };
  };
  const app = { config, index, firstStep: 0 } as App;
  app.data = await loading<Dataset>(PANELS, hash.mode === "clim" && climUrl ? openClim().then((c) => c.forPeriod(hash.period ?? "global")) : openCycle(firstCycle)); // fmt: skip
  const labels = new Labels(app);
  const logOf = (h: HashState) => (h.log === undefined ? undefined : parseLog(h.log, Object.keys(labels.logDefault)));
  const store = new Store({
    mode: climOf(app.data) ? "clim" : "live",
    period: climOf(app.data)?.period ?? "global",
    cycle: firstCycle,
    ...resolve(hash, app.data, fallback(app.data)),
    playing: false,
    diurnalKind: "box",
    heightScale: config.heightScale,
    colourPerHeight: config.colourPerHeight,
    logValues: logOf(hash) ?? labels.logDefault,
  });
  app.store = store;
  const st = () => store.state;

  /** First step of the time axis: a forecast is shown from the current hour on, unless `explicit` (the URL) asks for
   * an earlier time; then, and if all of it is past, from its start. */
  const limitSteps = (step: number, explicit: boolean): number => {
    const k = app.data instanceof Cycle ? futureStep(app.data.times) : 0;
    app.firstStep = k < 0 || (explicit && step < k) ? 0 : k;
    return Math.max(step, app.firstStep);
  };
  store.state.step = limitSteps(st().step, hash.leadHours !== undefined);

  const render = new Renderer(app, labels);
  const downloads = new Downloads(store);

  // Controls
  const timeInput = $<HTMLInputElement>("time");
  const heightInput = $<HTMLInputElement>("height");
  const logHeight = $<HTMLInputElement>("log-height");
  const colourZ = $<HTMLInputElement>("colour-z");
  const logValues = $<HTMLInputElement>("log-values");
  const speed = $<HTMLButtonElement>("speed");
  let speedIndex = 1;
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
  timeInput.addEventListener("input", () => store.set({ step: +timeInput.value, playing: false }));
  heightInput.addEventListener("input", () => store.set({ zi: +heightInput.value }));
  $("play").addEventListener("click", () => store.set({ playing: !st().playing }));
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
  $("download").addEventListener("click", () => {
    const { data } = app;
    const file = data instanceof Cycle ? data.meta.download : undefined;
    if (!(data instanceof Cycle) || !file) return;
    const size = fmtBytes(file.bytes);
    downloads.ask(`Forecast run ${fmtCycle(data.id)} as NetCDF: ${file.file}, ${size}.`, [{ url: new URL(file.file, data.base).href, file: file.file, label: `Download (${size})` }]); // fmt: skip
  });
  $("clim-download").addEventListener("click", () => {
    const c = climOf(app.data);
    if (!c?.meta.downloads) return;
    downloads.ask(
      "The climatology of the whole domain as NetCDF: the monthly statistics (global, day, night) and the diurnal cycle per month, of Cₙ², r₀ and σᵢ².",
      c.meta.downloads.map(({ label, file, bytes }) => ({ url: new URL(file, c.base).href, file, label: `${label} (${fmtBytes(bytes)})` })), // fmt: skip
    );
  });
  const fillCycles = () => cycleSelect.replaceChildren(...app.index.cycles.map((id) => new Option(fmtCycle(id), id)));
  fillCycles();
  cycleSelect.addEventListener("change", () => switchCycle(cycleSelect.value, physical()));
  // The newest run, at the current time (the rest of the view stays)
  $("newer").addEventListener("click", () => void switchCycle(latestCycle(app.index), { ...physical(), leadHours: undefined })); // fmt: skip
  setInterval(async () => {
    try {
      const fresh = await loadIndex(config.dataUrl);
      if (fresh.cycles.join() === app.index.cycles.join()) return;
      app.index = fresh;
      fillCycles();
      if (app.data instanceof Cycle) cycleSelect.value = app.data.id;
      render.controls();
    } catch (e) {
      console.warn("Checking for new forecasts failed:", e);
    }
  }, INDEX_POLL_MS);
  $("mode-tabs").hidden = !climUrl;
  for (const b of document.querySelectorAll<HTMLButtonElement>(".kind-switch button"))
    b.addEventListener("click", () => store.set({ diurnalKind: b.dataset.kind as State["diurnalKind"] }));
  for (const b of $("mode-tabs").querySelectorAll<HTMLButtonElement>("button"))
    b.addEventListener("click", () => void switchMode(b.dataset.mode as Mode));
  for (const b of $("period").querySelectorAll<HTMLButtonElement>("button"))
    b.addEventListener("click", () => void switchPeriod(b.dataset.period!));
  setInterval(() => render.live(), LIVE_CHECK_MS); // the selection stays, the time moves on

  // Playback: waits for lead times that are not loaded yet
  let playTimer = 0;
  function schedulePlay() {
    clearTimeout(playTimer);
    if (!st().playing) return;
    playTimer = window.setTimeout(async () => {
      const next = st().step + 1 < app.data.times.length ? st().step + 1 : app.firstStep;
      await app.data.loadStep(next);
      if (st().playing) {
        store.set({ step: next });
        schedulePlay();
      }
    }, config.playIntervalMs * SPEEDS[speedIndex][0]);
  }

  const syncUrl = () => history.replaceState(null, "", toHash(st(), app.data, labels.logDefault));
  store.subscribe((_, changed) => {
    render.update(changed);
    if (changed.has("playing")) schedulePlay();
    syncUrl();
  });

  // Switching cycles or between forecast and climatology keeps the physical view (lead hours or month, height,
  // location)
  const physical = (): HashState => {
    const s = st();
    const { data } = app;
    return defined({
      variable: s.variable,
      leadHours: data instanceof Cycle ? data.meta.lead_hours[s.step] : undefined,
      month: climOf(data)?.meta.months[s.step],
      stat: s.stat,
      z: data.z[s.zi],
      lat: s.cell >= 0 ? data.lat[Math.floor(s.cell / data.nlon)] : undefined,
      lon: s.cell >= 0 ? data.lon[s.cell % data.nlon] : undefined,
    });
  };
  /** Show `next` at the physical view `h`; `explicit`: `h` comes from the URL (it may ask for past times). */
  async function switchTo(next: Dataset, h: HashState, explicit = false) {
    store.set({ playing: false });
    app.data = next;
    labels.clearCmaps();
    render.setupData();
    await render.mapView.setData(next);
    const r = resolve(h, next, fallback(next));
    r.step = limitSteps(r.step, explicit && (h.leadHours !== undefined || h.month !== undefined));
    store.state = { ...st(), mode: climOf(next) ? "clim" : "live", period: climOf(next)?.period ?? st().period, ...(next instanceof Cycle && { cycle: next.id }), ...r, logValues: logOf(h) ?? st().logValues }; // fmt: skip
    await next.loadStep(r.step);
    render.all();
    syncUrl();
    void loading(["th"], next.loadAll(r.step, app.firstStep));
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
      if (app.data instanceof Cycle) h.month = app.data.times[st().step].getUTCMonth() + 1;
      const c = await (await openClim()).forPeriod(extra.period ?? st().period);
      return switchTo(c, { ...h, ...defined(extra) }, explicit);
    }
    const id = extra.cycle && app.index.cycles.includes(extra.cycle) ? extra.cycle : st().cycle;
    const next = cycle?.id === id ? cycle : await openCycle(id);
    await switchTo(next, { ...h, leadHours: liveLeadHours, ...defined(extra) }, explicit);
  }
  /** Global, day or night: the climatology of that period, the rest of the view stays. The buttons follow at once, the
   * last click wins. */
  async function switchPeriod(period: string, h = physical()) {
    const c = climOf(app.data);
    if (!c?.hasPeriod(period) || period === st().period) return;
    store.state.period = period;
    render.controls();
    try {
      const next = await loading(PANELS, c.forPeriod(period));
      if (st().period === period) await loading(PANELS, switchTo(next, h));
    } catch (e) {
      console.warn(`Loading the climatology (${period}) failed:`, e);
      if (st().period === period) store.state.period = climOf(app.data)?.period ?? "global";
      render.controls();
    }
  }

  // Links in the notes and edits of the URL
  addEventListener("hashchange", () => {
    const h = parseHash(location.hash);
    if (h.mode && h.mode !== st().mode) return void switchMode(h.mode, h, true);
    const { data } = app;
    if (data instanceof Cycle && h.cycle && h.cycle !== data.id && app.index.cycles.includes(h.cycle)) return void switchCycle(h.cycle, { ...physical(), ...defined(h) }, true); // fmt: skip
    if (h.period && h.period !== st().period && climOf(data)?.hasPeriod(h.period)) return void switchPeriod(h.period, { ...physical(), ...defined(h) }); // fmt: skip
    const before = app.firstStep;
    const r = resolve(h, data, { ...st() });
    r.step = limitSteps(r.step, h.leadHours !== undefined);
    const log = logOf(h);
    store.set({ ...r, playing: false, ...(log && { logValues: log }) });
    if (app.firstStep !== before) {
      render.timeHeight();
      render.controls();
      void data.loadAll(r.step, app.firstStep);
    }
  });

  addEventListener("keydown", (e) => {
    const t = e.target as HTMLElement;
    if (downloads.isOpen) return;
    if (t.tagName === "SELECT" || (t.tagName === "INPUT" && (t as HTMLInputElement).type !== "checkbox")) return;
    const s = st();
    const n = app.data.times.length;
    const step: Record<string, () => Partial<State>> = {
      " ": () => ({ playing: !s.playing }),
      ArrowRight: () => ({ step: s.step + 1 < n ? s.step + 1 : app.firstStep, playing: false }),
      ArrowLeft: () => ({ step: s.step > app.firstStep ? s.step - 1 : n - 1, playing: false }),
      ArrowUp: () => ({ zi: Math.min(app.data.nz - 1, s.zi + 1) }),
      ArrowDown: () => ({ zi: Math.max(0, s.zi - 1) }),
    };
    if (!step[e.key]) return;
    e.preventDefault();
    store.set(step[e.key]());
  });

  let resizeFrame = 0;
  const onResize = () => {
    cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(() => render.plots());
  };
  new ResizeObserver(onResize).observe($("profile"));
  new ResizeObserver(onResize).observe($("timeheight"));
  new ResizeObserver(onResize).observe($("diurnal"));

  render.setupData();
  await render.mapView.setData(app.data);
  await loading(PANELS, app.data.loadStep(st().step));
  render.all();
  syncUrl();
  $("th-hover").textContent = TH_HINT;
  void loading(["th"], app.data.loadAll(st().step, app.firstStep));
  // The climatology behind the forecast profile
  if (climUrl && !app.clim) void loading(["profile"], openClim()).then(() => app.data instanceof Cycle && render.profile());
}

main().catch((e: unknown) => {
  console.error(e);
  const el = $("error");
  el.hidden = false;
  el.textContent = `Could not load the data: ${e instanceof Error ? e.message : String(e)}`;
});
