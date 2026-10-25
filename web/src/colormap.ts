// Colour maps (d3-scale-chromatic) as lookup tables, and colour bars.

import * as chromatic from "d3-scale-chromatic";
import { scaleLinear } from "d3-scale";

const N = 256;

export class Colormap {
  readonly lut: Uint8ClampedArray; // N x RGB
  readonly css: string[];

  constructor(name = "viridis", reverse = false) {
    const key = `interpolate${name[0].toUpperCase()}${name.slice(1)}` as keyof typeof chromatic;
    const fn = (chromatic[key] as ((t: number) => string) | undefined) ?? chromatic.interpolateViridis;
    this.lut = new Uint8ClampedArray(N * 3);
    this.css = [];
    for (let k = 0; k < N; k++) {
      const c = fn(reverse ? 1 - k / (N - 1) : k / (N - 1));
      this.css.push(c);
      const rgb = c.startsWith("#") // "#rrggbb" or "rgb(r, g, b)"
        ? [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16))
        : c.match(/\d+/g)!.slice(0, 3).map(Number);
      this.lut.set(rgb, 3 * k);
    }
  }

  /** LUT index of `v` in [lo, hi] (clipped), -1 for NaN. */
  index(v: number, lo: number, hi: number): number {
    if (Number.isNaN(v)) return -1;
    return Math.max(0, Math.min(N - 1, Math.round(((v - lo) / (hi - lo)) * (N - 1))));
  }

  color(v: number, lo: number, hi: number): string {
    const k = this.index(v, lo, hi);
    return k < 0 ? "transparent" : this.css[k];
  }
}

/** Horizontal colour bar with ticks into `el` (its width). */
export function drawColorbar(el: HTMLElement, cmap: Colormap, [lo, hi]: [number, number], label: string) {
  const width = Math.max(120, el.clientWidth || 220);
  const canvas = document.createElement("canvas");
  canvas.width = N;
  canvas.height = 1;
  const ctx = canvas.getContext("2d")!;
  const img = ctx.createImageData(N, 1);
  for (let k = 0; k < N; k++) img.data.set([...cmap.lut.subarray(3 * k, 3 * k + 3), 255], 4 * k);
  ctx.putImageData(img, 0, 0);
  const x = scaleLinear().domain([lo, hi]).range([0, width]);
  const ticks = x.ticks(Math.max(2, Math.floor(width / 60)));
  const fmt = x.tickFormat(ticks.length);
  el.innerHTML = "";
  const title = document.createElement("div");
  title.className = "cb-label";
  title.textContent = label;
  canvas.className = "cb-bar";
  const axis = document.createElement("div");
  axis.className = "cb-ticks";
  for (const t of ticks) {
    const s = document.createElement("span");
    s.style.left = `${(x(t) / width) * 100}%`;
    s.textContent = fmt(t);
    axis.append(s);
  }
  el.append(title, canvas, axis);
}
