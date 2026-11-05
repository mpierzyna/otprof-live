// Downloads: every file goes through the dialog with the disclaimer.

import type { Climatology } from "./data";
import type { Store } from "./state";

export const fmtBytes = (bytes: number) => `${(bytes / 1e6).toFixed(bytes < 1e8 ? 1 : 0)} MB`;

/** Statistics in the CSV of a profile, as in the app: the distribution, then the means. */
const CSV_STATS = ["p5", "p25", "median", "p75", "p95", "mean", "lmean"];

/** The profile of a log₁₀ variable at a step and cell as CSV, as the browser has it: one row per height, the statistics
 * in log₁₀ (`lcn2_<stat>`) and linear (`cn2_<stat>`). Linear, `mean` is the mean of the linear values (the log₁₀ `lmean`)
 * and `gmean` the geometric mean (the log₁₀ `mean`). Undefined until the step is loaded. */
export function profileCsv(c: Climatology, name: string, step: number, cell: number): string | undefined {
  const stats = CSV_STATS.filter((k) => c.stats(name).includes(k));
  const columns = stats.map((k) => c.profile(name, step, cell, k));
  if (columns.some((a) => !a)) return undefined;
  const linear = name.replace(/^l/, "");
  const linearStat = (k: string) => (k === "mean" ? "gmean" : k === "lmean" ? "mean" : k);
  const header = ["z_agl_m", ...stats.map((k) => `${name}_${k}`), ...stats.map((k) => `${linear}_${linearStat(k)}`)];
  const value = (v: number, f: (v: number) => string) => (Number.isNaN(v) ? "" : f(v));
  const rows = c.z.map((z, i) => [
    z.toFixed(2),
    ...columns.map((a) => value(a![i], (v) => v.toFixed(3))),
    ...columns.map((a) => value(a![i], (v) => (10 ** v).toExponential(3))),
  ]);
  return `${[header, ...rows].map((row) => row.join(",")).join("\n")}\n`;
}

export class Downloads {
  private store: Store;
  private fileUrl?: string; // of a file made in the browser, kept until the next one
  private dialog: HTMLDialogElement;
  private what: HTMLElement;
  private links: HTMLElement;

  constructor(store: Store) {
    this.store = store;
    this.dialog = document.getElementById("download-dialog") as HTMLDialogElement;
    this.what = document.getElementById("download-what")!;
    this.links = document.getElementById("download-links")!;
    this.dialog.addEventListener("click", (e) => e.target === this.dialog && this.dialog.close()); // backdrop
  }

  get isOpen() {
    return this.dialog.open;
  }

  /** A URL for `text`, a file made in the browser. */
  textUrl(text: string, type: string): string {
    if (this.fileUrl) URL.revokeObjectURL(this.fileUrl);
    this.fileUrl = URL.createObjectURL(new Blob([text], { type }));
    return this.fileUrl;
  }

  /** The dialog: `what` is offered, one button per file (`url`, saved as `file`). */
  ask(what: string, files: { url: string; file: string; label: string }[]) {
    this.store.set({ playing: false });
    this.what.textContent = what;
    this.links.replaceChildren(
      ...files.map(({ url, file, label }) => {
        const link = document.createElement("a");
        link.className = "primary-button";
        link.href = url;
        link.download = file;
        link.textContent = label;
        link.addEventListener("click", () => this.dialog.close());
        return link;
      }),
    );
    this.dialog.showModal();
  }
}
