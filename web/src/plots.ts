// Profile panel (variable vs height at the selected cell and time) and time-height panel (the profile variable over
// the forecast or the months of the climatology at the selected cell, with the column variables as time series below),
// and the diurnal cycle of the climatology as box plots.

import { axisBottom, axisLeft } from "d3-axis";
import { format } from "d3-format";
import { type ScaleContinuousNumeric, scaleBand, scaleLinear, scaleLog, scaleUtc } from "d3-scale";
import { pointer, select, type Selection } from "d3-selection";
import { utcFormat } from "d3-time-format";
import type { Colormap } from "./colormap";
import { type Dataset, edges, nearestIndex } from "./data";
import { tickFormat as valueTicks } from "./format";

type Svg = Selection<SVGSVGElement, unknown, null, undefined>;
type G = Selection<SVGGElement, unknown, null, undefined>;

/** Height axis ticks: m below 1 km, km above. */
export function formatHeight(z: number): string {
  return z < 1000 ? `${format(".3~r")(z)} m` : `${format(".3~r")(z / 1000)} km`;
}

function heightScale(kind: "log" | "linear", z: number[]): ScaleContinuousNumeric<number, number> {
  return kind === "log" ? scaleLog().domain([z[0], z.at(-1)!]) : scaleLinear().domain([0, z.at(-1)!]);
}

function heightTicks(y: ScaleContinuousNumeric<number, number>, kind: "log" | "linear", px: number): number[] {
  if (kind === "linear") return y.ticks(Math.max(3, Math.floor(px / 40)));
  const [lo, hi] = y.domain();
  const out: number[] = [];
  for (let d = 10 ** Math.floor(Math.log10(lo)); d <= hi; d *= 10)
    for (const m of px > 260 ? [1, 2, 5] : [1]) if (d * m >= lo && d * m <= hi) out.push(d * m);
  return out;
}

const timeFormat = (t: Date) => (t.getUTCHours() === 0 ? utcFormat("%a %d %b")(t) : utcFormat("%H:%M")(t));

function svgIn(el: HTMLElement): Svg {
  el.innerHTML = "";
  return select(el).append("svg").attr("class", "plot");
}

export class ProfileView {
  private el: HTMLElement;
  private onPickZ: (zi: number) => void;
  private m = { top: 10, right: 16, bottom: 38, left: 52 };

  constructor(el: HTMLElement, onPickZ: (zi: number) => void) {
    this.el = el;
    this.onPickZ = onPickZ;
  }

  /** `profile` at the heights `z`, undefined: not loaded yet; `live`: drawn in the forecast colour. Context behind it:
   * `bands` (low, high per height of their own `z`, drawn on top of each other) and a dashed `reference` line.
   * `showZ` false: no marker of the selected height (a column-integrated variable is on the map). */
  draw(o: {
    z: number[];
    profile: Float32Array | undefined;
    live?: boolean;
    bands: { z: number[]; lo: Float32Array; hi: Float32Array }[];
    reference?: { z: number[]; values: Float32Array };
    zi: number;
    showZ?: boolean;
    heightScale: "log" | "linear";
    xDomain: [number, number];
    xLabel: string;
    fmt: (v: number) => string;
  }) {
    const { z, zi } = o;
    const width = this.el.clientWidth;
    const height = Math.max(240, this.el.clientHeight);
    const pw = width - this.m.left - this.m.right;
    const ph = height - this.m.top - this.m.bottom;
    const svg = svgIn(this.el).attr("width", width).attr("height", height);
    const g = svg.append("g").attr("transform", `translate(${this.m.left},${this.m.top})`);
    const x = scaleLinear().domain(o.xDomain).range([0, pw]).nice();
    const y = heightScale(o.heightScale, z).range([ph, 0]);
    const yTicks = heightTicks(y, o.heightScale, ph);

    g.append("g").attr("class", "grid").call(axisLeft(y).tickValues(yTicks).tickSize(-pw).tickFormat(() => ""));
    g.append("g").attr("class", "grid").attr("transform", `translate(0,${ph})`).call(axisBottom(x).ticks(5).tickSize(-ph).tickFormat(() => "")); // fmt: skip
    g.append("g").attr("class", "axis").attr("transform", `translate(0,${ph})`).call(axisBottom(x).ticks(Math.max(3, Math.floor(pw / 70))).tickFormat(valueTicks(x, Math.max(3, Math.floor(pw / 70))))); // fmt: skip
    g.append("g").attr("class", "axis").call(axisLeft(y).tickValues(yTicks).tickFormat((d) => formatHeight(+d)));
    g.append("text").attr("class", "axis-label").attr("x", pw / 2).attr("y", ph + 32).attr("text-anchor", "middle").text(o.xLabel); // fmt: skip

    const clip = `clip-${Math.random().toString(36).slice(2)}`;
    svg.append("clipPath").attr("id", clip).append("rect").attr("width", pw).attr("height", ph);
    const plot = g.append("g").attr("clip-path", `url(#${clip})`);

    for (const b of o.bands) {
      const band = b.z.map((h, k) => [x(b.lo[k]), x(b.hi[k]), y(h)]).filter(([a, c]) => Number.isFinite(a) && Number.isFinite(c)); // fmt: skip
      if (band.length > 1)
        plot.append("path").attr("class", "envelope").attr("d", `M${band.map(([a, , c]) => `${a},${c}`).join("L")}L${band.reverse().map(([, b, c]) => `${b},${c}`).join("L")}Z`); // fmt: skip
    }
    if (o.reference) {
      const r = o.reference;
      const pts = r.z.map((h, k) => [x(r.values[k]), y(h)]).filter(([a]) => Number.isFinite(a));
      if (pts.length) plot.append("path").attr("class", "reference").attr("d", `M${pts.join("L")}`);
    }

    const prof = o.profile;
    const sel = z[zi];
    const showZ = o.showZ ?? true;
    if (showZ) plot.append("line").attr("class", "z-cursor").attr("x1", 0).attr("x2", pw).attr("y1", y(sel)).attr("y2", y(sel)); // fmt: skip
    if (prof) {
      const pts = z.map((h, k) => [x(prof[k]), y(h)]).filter(([a]) => Number.isFinite(a));
      plot.append("path").attr("class", o.live ? "profile live" : "profile").attr("d", pts.length ? `M${pts.join("L")}` : ""); // fmt: skip
      const v = prof[zi];
      if (showZ && !Number.isNaN(v)) {
        plot.append("circle").attr("class", "z-marker").attr("cx", x(v)).attr("cy", y(sel)).attr("r", 3.5);
        const right = x(v) < pw - 110;
        g.append("text").attr("class", "z-label").attr("x", right ? x(v) + 8 : x(v) - 8).attr("y", y(sel) - 6)
          .attr("text-anchor", right ? "start" : "end").text(`${o.fmt(v)} at ${formatHeight(sel)}`); // fmt: skip
      }
    } else g.append("text").attr("class", "muted-text").attr("x", pw / 2).attr("y", ph / 2).attr("text-anchor", "middle").text("loading…"); // fmt: skip

    // Height: mouse click or drag; touch tap only, so that swipes scroll the page (touch-action in style.css)
    const pick = (ev: PointerEvent | MouseEvent) => {
      const [, py] = pointer(ev, g.node());
      if (py < 0 || py > ph) return;
      this.onPickZ(nearestIndex(z, y.invert(py)));
    };
    const hit = g.append("rect").attr("class", "hit tap").attr("width", pw).attr("height", ph);
    hit.on("pointerdown", (ev: PointerEvent) => {
      if (ev.pointerType !== "mouse") return;
      (ev.target as Element).setPointerCapture(ev.pointerId);
      pick(ev);
    });
    hit.on("pointermove", (ev: PointerEvent) => {
      if (ev.pointerType === "mouse" && ev.buttons) pick(ev);
    });
    hit.on("click", pick);
  }
}

export class TimeHeightView {
  private el: HTMLElement;
  private canvas = document.createElement("canvas");
  private svgHost = document.createElement("div");
  private onPick: (lead: number, zi?: number) => void;
  private onHover: (text: string) => void;
  private m = { top: 8, right: 16, bottom: 26, left: 52 };
  private stripH = 64;
  private gap = 20;
  private x = scaleUtc();
  private y: ScaleContinuousNumeric<number, number> = scaleLinear();
  private cursor?: G;
  private ph = 0;
  private showZ = true;

  constructor(el: HTMLElement, onPick: (lead: number, zi?: number) => void, onHover: (text: string) => void) {
    this.el = el;
    this.onPick = onPick;
    this.onHover = onHover;
    el.classList.add("th");
    this.canvas.className = "th-canvas";
    el.append(this.canvas, this.svgHost);
  }

  /** `stat`, `band`: statistic shown and the two statistics of the band around it in the strips (climatology).
   * `stepLabel`: hover text of a step. `months`: one tick per step, labelled with the month. `from`: first step shown.
   * `showZ` false: no line at the selected height (a column-integrated variable is on the map). `tf`: values as shown
   * (of the variable and of each column; e.g. 10^value for log₁₀ data shown linearly), `range` and `fmt` of those. */
  draw(o: {
    cycle: Dataset;
    name: string;
    cell: number;
    lead: number;
    zi: number;
    heightScale: "log" | "linear";
    cmap: Colormap;
    range: [number, number];
    fmt: (v: number) => string;
    columns: { name: string; label: string; fmt: (v: number) => string; tf?: (v: number) => number }[];
    tf?: (v: number) => number;
    stepLabel: (step: number) => string;
    stat?: string;
    band?: [string, string];
    months?: boolean;
    from?: number;
    showZ?: boolean;
  }) {
    const { cycle, name, cell, stat } = o;
    const tf = o.tf ?? ((v: number) => v);
    const from = o.from ?? 0;
    const shown = (l: number) => l >= from;
    const width = this.el.clientWidth;
    const nStrips = o.columns.length;
    const ph = Math.max(180, Math.round(width * 0.22));
    this.ph = ph;
    this.showZ = o.showZ ?? true;
    const height = this.m.top + ph + nStrips * (this.stripH + this.gap) + this.m.bottom;
    const pw = width - this.m.left - this.m.right;
    const tE = edges(cycle.times.map((t) => t.getTime()));
    const x = scaleUtc().domain([new Date(tE[from]), new Date(tE.at(-1)!)]).range([0, pw]);
    const y = heightScale(o.heightScale, cycle.z).range([ph, 0]);
    this.x = x;
    this.y = y;
    const zE = o.heightScale === "log" ? edges(cycle.z.map(Math.log)).map(Math.exp) : edges(cycle.z).map((v) => Math.max(0, v)); // fmt: skip

    // Heat map
    const dpr = devicePixelRatio || 1;
    Object.assign(this.canvas.style, { left: `${this.m.left}px`, top: `${this.m.top}px`, width: `${pw}px`, height: `${ph}px` }); // fmt: skip
    this.canvas.width = Math.round(pw * dpr);
    this.canvas.height = Math.round(ph * dpr);
    const ctx = this.canvas.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, pw, ph);
    const [lo, hi] = o.range;
    for (let l = from; l < cycle.times.length; l++) {
      const p = cycle.profile(name, l, cell, stat);
      if (!p) continue;
      const x0 = x(tE[l]);
      const x1 = x(tE[l + 1]);
      for (let k = 0; k < cycle.nz; k++) {
        if (Number.isNaN(p[k])) continue;
        const y0 = y(Math.max(zE[k], y.domain()[0]));
        const y1 = y(Math.min(zE[k + 1], y.domain()[1]));
        ctx.fillStyle = o.cmap.color(tf(p[k]), lo, hi);
        ctx.fillRect(x0, y1, x1 - x0 + 0.5, y0 - y1 + 0.5);
      }
    }

    // Axes, strips
    this.svgHost.innerHTML = "";
    const svg = select(this.svgHost).append("svg").attr("class", "plot").attr("width", width).attr("height", height);
    const g = svg.append("g").attr("transform", `translate(${this.m.left},${this.m.top})`);
    const xTicks = o.months ? cycle.times.slice(from) : x.ticks(Math.max(3, Math.floor(pw / 90)));
    const tickFormat = o.months ? utcFormat(pw > 420 ? "%b" : "%-m") : timeFormat;
    const yTicks = heightTicks(y, o.heightScale, ph);
    g.append("g").attr("class", "axis").call(axisLeft(y).tickValues(yTicks).tickFormat((d) => formatHeight(+d)));
    g.append("g").attr("class", "axis").attr("transform", `translate(0,${ph})`).call(axisBottom(x).tickValues(xTicks).tickFormat(() => "")); // fmt: skip
    g.append("rect").attr("class", "frame").attr("width", pw).attr("height", ph);

    o.columns.forEach((c, s) => {
      const top = ph + this.gap + s * (this.stripH + this.gap);
      const gs = g.append("g").attr("transform", `translate(0,${top})`);
      const series = (s?: string) => (c.tf ? cycle.series(c.name, cell, s).map(c.tf) : cycle.series(c.name, cell, s));
      const v = series(stat);
      const band = o.band?.map(series);
      const finite = [v, ...(band ?? [])].flatMap((a) => [...a.subarray(from)]).filter((a) => !Number.isNaN(a));
      const ys = scaleLinear().domain(finite.length ? [Math.min(...finite), Math.max(...finite)] : [0, 1]).range([this.stripH, 0]).nice(3); // fmt: skip
      gs.append("g").attr("class", "grid").call(axisLeft(ys).ticks(3).tickSize(-pw).tickFormat(() => ""));
      gs.append("g").attr("class", "axis").call(axisLeft(ys).ticks(3).tickFormat(valueTicks(ys, 3)));
      const last = s === nStrips - 1;
      gs.append("g").attr("class", "axis").attr("transform", `translate(0,${this.stripH})`)
        .call(axisBottom(x).tickValues(xTicks).tickFormat((d) => (last ? tickFormat(d as Date) : ""))); // fmt: skip
      if (band) {
        const area = cycle.times.map((t, l) => [x(t), ys(band[0][l]), ys(band[1][l])]).filter(([, a, b], l) => shown(l) && Number.isFinite(a) && Number.isFinite(b)); // fmt: skip
        if (area.length > 1)
          gs.append("path").attr("class", "envelope").attr("d", `M${area.map(([a, b]) => `${a},${b}`).join("L")}L${area.reverse().map(([a, , c]) => `${a},${c}`).join("L")}Z`); // fmt: skip
      }
      const pts = cycle.times.map((t, l) => [x(t), ys(v[l])]).filter(([, b], l) => shown(l) && Number.isFinite(b));
      gs.append("path").attr("class", "series").attr("d", pts.length ? `M${pts.join("L")}` : "");
      gs.append("text").attr("class", "strip-label").attr("x", 6).attr("y", 12).text(c.label);
    });

    // Cursors (moved by setCursor)
    this.cursor = g.append("g").attr("class", "cursors");
    const total = ph + nStrips * (this.stripH + this.gap);
    this.cursor.append("line").attr("class", "t-cursor").attr("y1", 0).attr("y2", total);
    this.cursor.append("line").attr("class", "z-cursor").attr("x1", 0).attr("x2", pw);
    this.setCursor(cycle, o.lead, o.zi);

    // Time (and height in the heat map): mouse click or drag; touch tap, or horizontal drag for time only (vertical
    // swipes scroll the page, touch-action in style.css). Hover: value.
    const hit = g.append("rect").attr("class", "hit scrub").attr("width", pw).attr("height", total);
    const at = (ev: PointerEvent | MouseEvent) => {
      const [px, py] = pointer(ev, g.node());
      const lead = from + nearestIndex(cycle.times.slice(from).map((t) => t.getTime()), x.invert(px).getTime());
      const zi = py >= 0 && py <= ph ? nearestIndex(cycle.z, y.invert(py)) : undefined;
      return { lead, zi };
    };
    let start: [number, number] | null = null; // touch: scrub only once the drag is clearly horizontal
    hit.on("pointerdown", (ev: PointerEvent) => {
      if (ev.pointerType !== "mouse") return void (start = [ev.clientX, ev.clientY]);
      (ev.target as Element).setPointerCapture(ev.pointerId);
      const { lead, zi } = at(ev);
      this.onPick(lead, zi);
    });
    hit.on("pointerup pointercancel", () => (start = null));
    hit.on("click", (ev: MouseEvent) => {
      const { lead, zi } = at(ev);
      this.onPick(lead, zi);
    });
    hit.on("pointermove", (ev: PointerEvent) => {
      const { lead, zi } = at(ev);
      if (ev.pointerType === "mouse" && ev.buttons) this.onPick(lead, zi);
      if (ev.pointerType !== "mouse" && start) {
        const [dx, dy] = [Math.abs(ev.clientX - start[0]), Math.abs(ev.clientY - start[1])];
        if (dx > 8 && dx > 2 * dy) this.onPick(lead);
      }
      const t = o.stepLabel(lead);
      if (zi === undefined) return this.onHover(t);
      const p = cycle.profile(name, lead, cell, stat);
      this.onHover(`${t}, ${formatHeight(cycle.z[zi])}: ${p && !Number.isNaN(p[zi]) ? o.fmt(tf(p[zi])) : "–"}`);
    });
    hit.on("pointerleave", () => this.onHover(""));
  }

  setCursor(cycle: Dataset, lead: number, zi: number) {
    if (!this.cursor) return;
    const tx = this.x(cycle.times[lead]);
    this.cursor.select(".t-cursor").attr("x1", tx).attr("x2", tx);
    const zy = this.y(cycle.z[zi]);
    this.cursor.select(".z-cursor").attr("y1", zy).attr("y2", zy).attr("visibility", this.showZ && zy >= 0 && zy <= this.ph ? "visible" : "hidden"); // fmt: skip
  }
}

/** One box: whiskers p5 to p95, box p25 to p75, median line, mean dot. */
export type BoxStats = Record<"p5" | "p25" | "median" | "p75" | "p95" | "mean", Float32Array> & { lmean?: Float32Array };

/** Densities of a violin per hour (scaled to a maximum of 1) at the values `x`. */
export interface Violins {
  x: number[];
  density: Float32Array[];
}

const VIOLIN_MIN_DENSITY = 0.01; // tails below this fraction of the peak are not drawn

/** Values and densities of one violin, trimmed to where the density reaches `VIOLIN_MIN_DENSITY`. */
function violinOutline(x: number[], d: Float32Array): [number, number][] {
  const ok = (i: number) => !Number.isNaN(d[i]) && d[i] >= VIOLIN_MIN_DENSITY;
  let lo = 0;
  let hi = x.length - 1;
  while (lo <= hi && !ok(lo)) lo++;
  while (hi >= lo && !ok(hi)) hi--;
  return lo > hi ? [] : x.slice(lo, hi + 1).map((v, i) => [v, d[lo + i]]);
}

/** Diurnal cycle of the climatology, one plot per variable: box plots per hour, or violins (with the box inside). */
export class DiurnalView {
  private el: HTMLElement;
  private m = { top: 22, right: 12, bottom: 34, left: 48 };
  private height = 220;

  constructor(el: HTMLElement) {
    this.el = el;
  }

  draw(
    hours: number[],
    kind: "box" | "violin",
    plots: { label: string; fmt: (v: number) => string; boxes: BoxStats | undefined; violins?: Violins }[],
  ) {
    this.el.innerHTML = "";
    // All hosts first: their widths depend on how many share the grid row
    const hosts = plots.map(() => this.el.appendChild(document.createElement("div")));
    for (const [n, p] of plots.entries()) {
      const host = hosts[n];
      const width = host.clientWidth;
      const pw = width - this.m.left - this.m.right;
      const ph = this.height - this.m.top - this.m.bottom;
      const svg = select(host).append("svg").attr("class", "plot").attr("width", width).attr("height", this.height);
      const g = svg.append("g").attr("transform", `translate(${this.m.left},${this.m.top})`);
      g.append("text").attr("class", "strip-label").attr("x", 0).attr("y", -8).text(p.label);
      const b = p.boxes;
      if (!b) continue;
      const violins = kind === "violin" && p.violins ? p.violins.density.map((d) => violinOutline(p.violins!.x, d)) : undefined; // fmt: skip
      const finite = [...b.p5, ...b.p95, ...(violins?.flat().map(([v]) => v) ?? [])].filter((v) => !Number.isNaN(v));
      const x = scaleBand<number>().domain(hours).range([0, pw]).padding(violins ? 0.1 : 0.35);
      const y = scaleLinear().domain(finite.length ? [Math.min(...finite), Math.max(...finite)] : [0, 1]).range([ph, 0]).nice(4); // fmt: skip
      g.append("g").attr("class", "grid").call(axisLeft(y).ticks(4).tickSize(-pw).tickFormat(() => ""));
      g.append("g").attr("class", "axis").call(axisLeft(y).ticks(4).tickFormat(valueTicks(y, 4)));
      g.append("g").attr("class", "axis").attr("transform", `translate(0,${ph})`)
        .call(axisBottom(x).tickFormat((h) => format("02d")(h))); // fmt: skip
      g.append("text").attr("class", "axis-label").attr("x", pw / 2).attr("y", ph + 30).attr("text-anchor", "middle").text("Hour (UTC)"); // fmt: skip
      const clip = `clip-${Math.random().toString(36).slice(2)}`;
      svg.append("clipPath").attr("id", clip).append("rect").attr("width", pw).attr("height", ph);
      const plot = g.append("g").attr("clip-path", `url(#${clip})`);

      hours.forEach((h, k) => {
        if ([b.p5, b.p25, b.median, b.p75, b.p95].some((a) => Number.isNaN(a[k]))) return;
        const cx = x(h)! + x.bandwidth() / 2;
        const box = plot.append("g").attr("class", "box");
        box.append("title").text(
          `${format("02d")(h)} UTC: median ${p.fmt(b.median[k])}, mean ${p.fmt(b.mean[k])}\n` +
            `25–75 %: ${p.fmt(b.p25[k])} to ${p.fmt(b.p75[k])}\n5–95 %: ${p.fmt(b.p5[k])} to ${p.fmt(b.p95[k])}`,
        );
        if (violins) {
          const outline = violins[k];
          const half = x.bandwidth() / 2;
          if (outline.length > 1) {
            const right = outline.map(([v, d]) => `${cx + half * d},${y(v)}`);
            const left = outline.map(([v, d]) => `${cx - half * d},${y(v)}`).reverse();
            box.append("path").attr("class", "violin").attr("d", `M${right.join("L")}L${left.join("L")}Z`);
          }
          const w = Math.max(3, x.bandwidth() * 0.12);
          box.append("rect").attr("class", "inner").attr("x", cx - w / 2).attr("width", w).attr("y", y(b.p75[k])).attr("height", Math.max(1, y(b.p25[k]) - y(b.p75[k]))); // fmt: skip
          box.append("line").attr("class", "median").attr("x1", cx - 2 * w).attr("x2", cx + 2 * w).attr("y1", y(b.median[k])).attr("y2", y(b.median[k])); // fmt: skip
        } else {
          box.append("line").attr("class", "whisker").attr("x1", cx).attr("x2", cx).attr("y1", y(b.p5[k])).attr("y2", y(b.p95[k])); // fmt: skip
          box.append("rect").attr("x", x(h)!).attr("width", x.bandwidth()).attr("y", y(b.p75[k])).attr("height", Math.max(1, y(b.p25[k]) - y(b.p75[k]))); // fmt: skip
          box.append("line").attr("class", "median").attr("x1", x(h)!).attr("x2", x(h)! + x.bandwidth()).attr("y1", y(b.median[k])).attr("y2", y(b.median[k])); // fmt: skip
        }
        if (!Number.isNaN(b.mean[k])) box.append("circle").attr("cx", cx).attr("cy", y(b.mean[k])).attr("r", 2.5);
      });
    }
  }
}
