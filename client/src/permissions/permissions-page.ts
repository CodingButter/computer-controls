/**
 * The permissions page: every application the daemon knows about gets a
 * checkbox. Checked means an agent may interact with it; unchecked means the
 * application is absent from the agent's view entirely — not present-and-
 * disabled, but simply not there.
 *
 * The page is a thin driver, same as the settings page: it reads the registry
 * on load, sends a write when a box is toggled, and refreshes. There is no
 * submit button because the effect is live — ruling 4 says checking or
 * unchecking takes effect without restarting the daemon or the hub.
 */

import { PERMISSIONS_API_PATH } from "./routes.ts";

const STYLES = `
  :root { color-scheme: light dark; }
  body { font: 15px/1.5 system-ui, sans-serif; margin: 0; padding: 2.5rem 1.5rem; }
  main { max-width: 34rem; margin: 0 auto; }
  h1 { font-size: 1.3rem; margin: 0 0 .25rem; }
  p.lede { margin: 0 0 2rem; opacity: .7; }
  .apps { display: flex; flex-direction: column; gap: .5rem; }
  .app {
    display: flex; align-items: center; gap: .6rem;
    padding: .6rem .9rem;
    border: 1px solid currentColor; border-radius: .4rem;
    cursor: pointer;
  }
  .app:hover { opacity: .85; }
  .app input { width: 1.15rem; height: 1.15rem; cursor: pointer; margin: 0; }
  .app .name { flex: 1; }
  .app .badge { font-size: .8rem; opacity: .6; }
  .empty { opacity: .6; }
  .error { color: #b3261e; font-size: .9rem; margin-top: .5rem; }
`;

const SCRIPT = String.raw`
const API = "__API__";

async function refresh() {
  const list = document.getElementById("apps");
  const error = document.getElementById("error");
  error.textContent = "";

  let data;
  try {
    const response = await fetch(API, { credentials: "same-origin" });
    data = await response.json();
    if (!response.ok) throw new Error(data.error || "Request failed.");
  } catch (problem) {
    list.innerHTML = "";
    error.textContent = problem.message;
    return;
  }

  const apps = data.applications || [];
  if (!apps.length) {
    list.innerHTML = '<p class="empty">No applications detected yet. Open the apps you want the agent to see, then revisit this page.</p>';
    return;
  }

  list.replaceChildren(...apps.map((app) => {
    const label = document.createElement("label");
    label.className = "app";
    label.dataset.name = app.name;

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = app.permitted;

    const name = document.createElement("span");
    name.className = "name";
    name.textContent = app.name;

    const badge = document.createElement("span");
    badge.className = "badge";
    badge.textContent = app.permitted ? "permitted" : "blocked";

    label.append(checkbox, name, badge);

    checkbox.addEventListener("change", async () => {
      error.textContent = "";
      badge.textContent = "…";
      try {
        const response = await fetch(API, {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ application: app.name, permitted: checkbox.checked }),
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "Request failed.");
        badge.textContent = result.permitted ? "permitted" : "blocked";
      } catch (problem) {
        checkbox.checked = !checkbox.checked;
        badge.textContent = checkbox.checked ? "permitted" : "blocked";
        error.textContent = problem.message;
      }
    });

    return label;
  }));
}

refresh();
`;

export function renderPermissionsPage(apiPath: string = PERMISSIONS_API_PATH): string {
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Application permissions</title>
<style>${STYLES}</style>
<main>
  <h1>Application permissions</h1>
  <p class="lede">Check the applications an agent may interact with. Unchecked apps are invisible to the agent — absent from every listing, not present and disabled. Changes take effect immediately.</p>
  <div id="apps" class="apps"></div>
  <p class="error" role="alert"></p>
</main>
<script type="module">${SCRIPT.replace("__API__", apiPath)}</script>
</html>`;
}
