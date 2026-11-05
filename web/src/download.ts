// Downloads: every file goes through the dialog with the disclaimer.

import type { Store } from "./state";

export const fmtBytes = (bytes: number) => `${(bytes / 1e6).toFixed(bytes < 1e8 ? 1 : 0)} MB`;

export class Downloads {
  private store: Store;
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
