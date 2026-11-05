import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { Marked, type MarkedExtension, type Token } from "marked";
import { liteAdaptor } from "mathjax-full/js/adaptors/liteAdaptor.js";
import { RegisterHTMLHandler } from "mathjax-full/js/handlers/html.js";
import { TeX } from "mathjax-full/js/input/tex.js";
import { AllPackages } from "mathjax-full/js/input/tex/AllPackages.js";
import { mathjax } from "mathjax-full/js/mathjax.js";
import { SVG } from "mathjax-full/js/output/svg.js";
import { type Connect, defineConfig, type Plugin } from "vite";

// Development data (default: the pipelines' web data, pipeline/data/webui) served at /data/ by the dev and preview
// servers only, so it never ends up in the build: in production the web server delivers it at the same path.
const DEV_DATA = resolve(__dirname, process.env.OTPROF_LIVE_DATA ?? "../pipeline/data/webui");
const TYPES: Record<string, string> = { ".json": "application/json", ".md": "text/markdown; charset=utf-8" };

function devData(): Plugin {
  const serve = (server: { middlewares: Connect.Server }) => {
    server.middlewares.use("/data", (req, res, next) => {
      const path = resolve(DEV_DATA, `.${decodeURIComponent((req.url ?? "/").split("?")[0])}`);
      if (!path.startsWith(DEV_DATA) || !existsSync(path) || !statSync(path).isFile()) return next();
      res.setHeader("Content-Type", TYPES[path.slice(path.lastIndexOf("."))] ?? "application/octet-stream");
      createReadStream(path).pipe(res);
    });
  };
  return { name: "dev-data", configureServer: serve, configurePreviewServer: serve };
}

// Texts of the app (content/*.md, see content/README.md) rendered into index.html at build time:
// <!--content:NAME--> the markdown of content/NAME.md, <!--content:NAME:inline--> as inline markdown (title),
// <!--content:NAME:text--> as plain text (<title>), <!--content:NAME:heading--> its first heading (inline) and
// <!--content:NAME:body--> the rest. Links not starting with /forecast or /climatology (those set the view) open in a new
// tab.
const CONTENT = resolve(__dirname, "content");

// LaTeX in the texts: $...$ inline, $$...$$ displayed, rendered by MathJax to SVG at build time (no fonts or scripts in
// the browser; the SVG takes the text colour). A literal dollar sign: \$.
function math(): MarkedExtension {
  const adaptor = liteAdaptor();
  RegisterHTMLHandler(adaptor);
  const doc = mathjax.document("", { InputJax: new TeX({ packages: AllPackages }), OutputJax: new SVG({ fontCache: "local" }) });
  const tex = (src: string, display: boolean) => adaptor.outerHTML(doc.convert(src, { display }));
  return {
    extensions: [
      {
        name: "math",
        level: "inline",
        start: (src) => src.indexOf("$"),
        tokenizer(src) {
          // No space inside the delimiters and no digit after the closing one, so prices like $5 and $10 stay text
          const m = /^(\$\$?)(?!\s)((?:\\.|[^\\$])+?)(?<!\s)\1(?!\d)/.exec(src);
          return m ? { type: "math", raw: m[0], text: m[2], display: m[1].length === 2 } : undefined;
        },
        renderer: (t) => tex(t.text, t.display),
      },
    ],
  };
}
const marked = new Marked(math());

function content(): Plugin {
  const external = (html: string) => html.replace(/<a href="(?!\/(?:forecast|climatology)\b)/g, '<a target="_blank" rel="noopener noreferrer" href="');
  const parse = (tokens: Token[]) => external(marked.parser(tokens));
  const inline = (md: string) => external(marked.parseInline(md.trim(), { async: false }));
  const render = (name: string, part = "") => {
    const md = readFileSync(resolve(CONTENT, `${name}.md`), "utf-8");
    const tokens = marked.lexer(md);
    const k = tokens.findIndex((t) => t.type === "heading");
    if (part === "inline") return inline(md);
    if (part === "text") return inline(md).replace(/<[^>]*>/g, "");
    if (part === "heading") return k < 0 ? "" : inline((tokens[k] as Token & { text: string }).text);
    if (part === "body") return parse(tokens.filter((_, i) => i !== k));
    if (part) throw new Error(`content:${name}:${part}: unknown part`);
    return parse(tokens);
  };
  return {
    name: "content",
    transformIndexHtml: (html) =>
      html.replace(/<!--content:([\w-]+)(?::(\w+))?-->/g, (_, name: string, part?: string) => render(name, part)),
    configureServer(server) {
      server.watcher.add(CONTENT);
      server.watcher.on("change", (file) => file.startsWith(CONTENT) && server.ws.send({ type: "full-reload" }));
    },
  };
}

// The app has paths of its own (/forecast/.., /climatology/..), so its files have absolute URLs: it is served from the root
// of the web server, or from OTPROF_BASE (e.g. /otprof/, then adjust the routes in nginx.conf too).
// Dev server on another interface (e.g. Tailscale):  npm run dev -- --host <ip>
export default defineConfig({
  base: process.env.OTPROF_BASE ?? "/",
  build: { chunkSizeWarningLimit: 1500 },
  server: { port: 5173, strictPort: true },
  preview: { port: 4173, strictPort: true },
  plugins: [devData(), content()],
});
