# Texts of the app

Markdown, rendered into `index.html` when the app is built (`vite.config.ts`, plugin `content`): edit, then push and
deploy. `npm run dev` reloads on every change. Links starting with `#` set the view (e.g. `#lat=52&lon=5&z=1000&t=12`),
other links open in a new tab.

| file | shown |
|---|---|
| `title.md` | the title (inline markdown; plain text in the browser tab) |
| `subtitle.md` | below the title (inline markdown) |
| `disclaimer.md` | the callout above the panels and in the download dialog; its first heading is the callout's title |
| `about.md` | the notes card below the plots |
| `climatology.md` | the notes card in the climatology, after `about.md` |
| `download.md` | the download dialog: its first heading is the dialog's title, the rest is shown above the buttons |
| `footer.md` | the footer (inline markdown) |

Labels and units of the variables are in `public/config.json`; short hints of the plots are in `src/main.ts`.
