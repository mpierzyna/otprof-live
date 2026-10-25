// App settings (public/config.json): presentation only, the data describe themselves (docs/DATA_FORMAT.md).

export interface VarConfig {
  label?: string;
  units?: string;
  colormap?: string; // d3-scale-chromatic name: viridis, magma, inferno, plasma, cividis, turbo, ...
  reverse?: boolean;
  range?: [number, number]; // colour range, overrides the data's display_range
  format?: string; // d3-format specifier for values
}

export interface Config {
  title: string;
  subtitle?: string;
  dataUrl: string;
  notes?: string;
  disclaimer?: string; // markdown file shown in a red box above the panels
  basemapUrl: string;
  mapPaddingDeg: number;
  playIntervalMs: number;
  heightScale: "log" | "linear";
  colourPerHeight: boolean;
  variables: Record<string, VarConfig>;
  defaults: { variable?: string; z?: number; lat?: number; lon?: number };
}

const DEFAULTS: Config = {
  title: "OTProf live",
  dataUrl: "data/",
  basemapUrl: "basemap/",
  mapPaddingDeg: 1,
  playIntervalMs: 400,
  heightScale: "log",
  colourPerHeight: true,
  variables: {},
  defaults: {},
};

export async function loadConfig(): Promise<Config> {
  const r = await fetch("config.json", { cache: "no-cache" });
  const user = r.ok ? ((await r.json()) as Partial<Config>) : {};
  const config = { ...DEFAULTS, ...user };
  // URLs relative to the page
  config.dataUrl = new URL(config.dataUrl.endsWith("/") ? config.dataUrl : `${config.dataUrl}/`, location.href).href;
  config.basemapUrl = new URL(config.basemapUrl.endsWith("/") ? config.basemapUrl : `${config.basemapUrl}/`, location.href).href;
  return config;
}
