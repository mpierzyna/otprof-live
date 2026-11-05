// Annotations from markdown files (sanitised). Links like [text](/forecast/r0?t=12&z=100&lat=52&lon=5) set the view.

import DOMPurify from "dompurify";
import { marked } from "marked";
import { viewLink } from "./router";

DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A" && !viewLink(node.getAttribute("href") ?? "")) {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
});

/** Markdown of the URLs that exist (missing files are skipped), rendered into `el`. Returns whether there was any. */
export async function renderNotes(el: HTMLElement, urls: string[]): Promise<boolean> {
  const texts = await Promise.all(
    urls.map(async (u) => {
      try {
        const r = await fetch(u, { cache: "no-cache" });
        // Servers with an SPA fallback answer missing files with index.html
        return r.ok && !r.headers.get("content-type")?.includes("text/html") ? await r.text() : "";
      } catch {
        return "";
      }
    }),
  );
  const md = texts.filter((t) => t.trim()).join("\n\n---\n\n");
  el.innerHTML = DOMPurify.sanitize(await marked.parse(md));
  el.hidden = !md;
  return !!md;
}
