// The colour theme before the first paint (no flash of the light theme): the choice stored by the theme switch, else
// the system setting. main.ts (setupTheme) keeps it up to date. A file, not inline: the CSP allows only 'self' scripts.
(function () {
  var choice = null;
  try {
    choice = localStorage.getItem("otprof-live.theme");
  } catch (e) {}
  var dark = choice === "dark" || (choice !== "light" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
})();
