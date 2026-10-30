// Map panel: the field as a canvas image in Web Mercator (rows uniform in Mercator y, so the cells sit exactly on the
// lat-lon grid), basemap from static GeoJSON, the data domain outline and the selected cell.

import type { Feature, MultiLineString, Polygon } from "geojson";
import { type CanvasSource, type GeoJSONSource, Map as MapLibre, NavigationControl, setWorkerUrl } from "maplibre-gl";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?url";
import "maplibre-gl/dist/maplibre-gl.css";
import type { Colormap } from "./colormap";
import { bin, type Dataset, edges } from "./data";

// The worker is self-contained: served as a file of its own, both by the dev server and in the build
setWorkerUrl(workerUrl);

const PX_PER_CELL = 8;
const rad = (d: number) => (d * Math.PI) / 180;
const mercY = (lat: number) => Math.log(Math.tan(Math.PI / 4 + rad(lat) / 2));
const invMercY = (y: number) => ((2 * Math.atan(Math.exp(y)) - Math.PI / 2) * 180) / Math.PI;
const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export class MapView {
  readonly map: MapLibre;
  private canvas = document.createElement("canvas");
  private ctx = this.canvas.getContext("2d")!;
  private img?: ImageData;
  private pixCell = new Int32Array(0); // canvas pixel -> cell, -1 outside
  private latE: number[] = [];
  private lonE: number[] = [];
  private cycle?: Dataset;
  private ready: Promise<void>;
  private padding: number;

  constructor(
    el: HTMLElement,
    basemapUrl: string,
    padding: number,
    onPick: (cell: number) => void,
    onHover: (cell: number, point: { x: number; y: number } | null) => void,
  ) {
    this.padding = padding;
    this.map = new MapLibre({
      container: el,
      style: {
        version: 8,
        sources: {
          land: { type: "geojson", data: `${basemapUrl}land.geojson` },
          borders: { type: "geojson", data: `${basemapUrl}borders.geojson` },
        },
        layers: [
          { id: "sea", type: "background", paint: { "background-color": css("--map-sea") } },
          { id: "land", type: "fill", source: "land", paint: { "fill-color": css("--map-land") } },
        ],
      },
      center: [5, 52],
      zoom: 5,
      dragRotate: false,
      // Touch screens: one finger scrolls the page, two fingers move the map (taps still select)
      cooperativeGestures: matchMedia("(pointer: coarse)").matches,
      pitchWithRotate: false,
      touchPitch: false,
      attributionControl: { compact: true, customAttribution: "Basemap: Natural Earth" },
    });
    this.map.touchZoomRotate.disableRotation();
    this.map.keyboard.disable(); // the arrow keys step time and height
    this.map.addControl(new NavigationControl({ showCompass: false }), "top-right");
    new ResizeObserver(() => this.map.resize()).observe(el);

    this.ready = new Promise((resolve) =>
      this.map.on("load", () => {
        this.canvas.width = this.canvas.height = 1;
        this.map.addSource("field", {
          type: "canvas",
          canvas: this.canvas,
          animate: false,
          coordinates: [[0, 1], [1, 1], [1, 0], [0, 0]],
        }); // fmt: skip
        this.map.addSource("domain", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
        this.map.addSource("selection", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
        this.map.addLayer({
          id: "field",
          type: "raster",
          source: "field",
          paint: { "raster-resampling": "nearest", "raster-fade-duration": 0, "raster-opacity": 0.95 },
        });
        this.map.addLayer({ id: "coast", type: "line", source: "land", paint: { "line-color": css("--map-line"), "line-width": 0.8 } }); // fmt: skip
        this.map.addLayer({ id: "borders", type: "line", source: "borders", paint: { "line-color": css("--map-line"), "line-width": 0.6, "line-dasharray": [3, 2] } }); // fmt: skip
        this.map.addLayer({ id: "domain", type: "line", source: "domain", paint: { "line-color": css("--map-domain"), "line-width": 1 } }); // fmt: skip
        this.map.addLayer({ id: "sel-halo", type: "line", source: "selection", paint: { "line-color": "#000", "line-width": 3.5 } }); // fmt: skip
        this.map.addLayer({ id: "sel", type: "line", source: "selection", paint: { "line-color": "#fff", "line-width": 1.5 } }); // fmt: skip
        resolve();
      }),
    );

    this.map.on("click", (e) => {
      const cell = this.cellAt(e.lngLat.lng, e.lngLat.lat);
      if (cell >= 0) onPick(cell);
    });
    this.map.on("mousemove", (e) => {
      const cell = this.cellAt(e.lngLat.lng, e.lngLat.lat);
      this.map.getCanvas().style.cursor = cell >= 0 ? "crosshair" : "";
      onHover(cell, cell >= 0 ? e.point : null);
    });
    this.map.on("mouseout", () => onHover(-1, null));
    addEventListener("themechange", () => this.applyTheme()); // main.ts (setupTheme)
  }

  private applyTheme() {
    if (!this.map.isStyleLoaded()) return;
    this.map.setPaintProperty("sea", "background-color", css("--map-sea"));
    this.map.setPaintProperty("land", "fill-color", css("--map-land"));
    for (const id of ["coast", "borders"]) this.map.setPaintProperty(id, "line-color", css("--map-line"));
    this.map.setPaintProperty("domain", "line-color", css("--map-domain"));
  }

  /** Valid cell at (lon, lat), or -1. */
  cellAt(lon: number, lat: number): number {
    if (!this.cycle) return -1;
    const i = bin(this.latE, lat);
    const j = bin(this.lonE, lon);
    if (i < 0 || j < 0) return -1;
    const cell = i * this.cycle.nlon + j;
    return this.cycle.valid[cell] ? cell : -1;
  }

  async setCycle(cycle: Dataset) {
    await this.ready;
    this.cycle = cycle;
    this.latE = edges(cycle.lat);
    this.lonE = edges(cycle.lon);
    const [w, e, s, n] = [this.lonE[0], this.lonE.at(-1)!, this.latE[0], this.latE.at(-1)!];

    // Canvas pixels -> cells
    const W = Math.min(2048, cycle.nlon * PX_PER_CELL);
    const H = Math.min(2048, Math.round((W * (mercY(n) - mercY(s))) / (rad(e) - rad(w))));
    this.canvas.width = W;
    this.canvas.height = H;
    this.img = this.ctx.createImageData(W, H);
    this.pixCell = new Int32Array(W * H);
    const colJ = Array.from({ length: W }, (_, c) => bin(this.lonE, w + ((c + 0.5) / W) * (e - w)));
    for (let r = 0; r < H; r++) {
      const i = bin(this.latE, invMercY(mercY(n) - ((r + 0.5) / H) * (mercY(n) - mercY(s))));
      for (let c = 0; c < W; c++) this.pixCell[r * W + c] = i < 0 || colJ[c] < 0 ? -1 : i * cycle.nlon + colJ[c];
    }
    (this.map.getSource("field") as CanvasSource).setCoordinates([[w, n], [e, n], [e, s], [w, s]]); // fmt: skip
    (this.map.getSource("domain") as GeoJSONSource).setData(this.domainOutline());

    const p = this.padding;
    const bounds: [number, number, number, number] = [w - p, s - p, e + p, n + p];
    this.map.setMaxBounds(null);
    this.map.fitBounds(bounds, { padding: 8, animate: false });
    this.map.setMaxBounds([w - 3 * p, s - 3 * p, e + 3 * p, n + 3 * p]);
  }

  /** Boundary between cells with and without data. */
  private domainOutline(): Feature<MultiLineString> {
    const c = this.cycle!;
    const ok = (i: number, j: number) => i >= 0 && j >= 0 && i < c.nlat && j < c.nlon && c.valid[i * c.nlon + j] === 1;
    const segs: [number, number][][] = [];
    const [la, lo] = [this.latE, this.lonE];
    for (let i = 0; i < c.nlat; i++)
      for (let j = 0; j < c.nlon; j++) {
        if (!ok(i, j)) continue;
        if (!ok(i - 1, j)) segs.push([[lo[j], la[i]], [lo[j + 1], la[i]]]); // fmt: skip
        if (!ok(i + 1, j)) segs.push([[lo[j], la[i + 1]], [lo[j + 1], la[i + 1]]]); // fmt: skip
        if (!ok(i, j - 1)) segs.push([[lo[j], la[i]], [lo[j], la[i + 1]]]); // fmt: skip
        if (!ok(i, j + 1)) segs.push([[lo[j + 1], la[i]], [lo[j + 1], la[i + 1]]]); // fmt: skip
      }
    return { type: "Feature", properties: {}, geometry: { type: "MultiLineString", coordinates: segs } };
  }

  /** Field (lat, lon) in colours; undefined (not loaded yet) keeps the previous image. */
  draw(values: Float32Array | undefined, cmap: Colormap, lo: number, hi: number) {
    if (!values || !this.img) return;
    const d = this.img.data;
    const lut = cmap.lut;
    for (let p = 0; p < this.pixCell.length; p++) {
      const cell = this.pixCell[p];
      const k = cell < 0 ? -1 : cmap.index(values[cell], lo, hi);
      if (k < 0) d[4 * p + 3] = 0;
      else {
        d[4 * p] = lut[3 * k];
        d[4 * p + 1] = lut[3 * k + 1];
        d[4 * p + 2] = lut[3 * k + 2];
        d[4 * p + 3] = 255;
      }
    }
    this.ctx.putImageData(this.img, 0, 0);
    // A static canvas source copies the canvas only while playing: one frame
    const src = this.map.getSource("field") as CanvasSource | undefined;
    if (!src) return;
    src.play();
    this.map.once("render", () => src.pause());
  }

  setSelection(cell: number) {
    const c = this.cycle;
    const src = this.map.getSource("selection") as GeoJSONSource | undefined;
    if (!c || !src) return;
    if (cell < 0) return src.setData({ type: "FeatureCollection", features: [] });
    const i = Math.floor(cell / c.nlon);
    const j = cell % c.nlon;
    const [s, n, w, e] = [this.latE[i], this.latE[i + 1], this.lonE[j], this.lonE[j + 1]];
    const f: Feature<Polygon> = {
      type: "Feature",
      properties: {},
      geometry: { type: "Polygon", coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] },
    }; // fmt: skip
    src.setData(f);
  }

  get whenReady() {
    return this.ready;
  }
}
