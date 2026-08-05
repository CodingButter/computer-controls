/**
 * The settings section: connect an account, see that it is connected, take it
 * back off again.
 *
 * Plain on purpose. This is the smallest surface that lets a person do the
 * thing the routes exist for, and every interesting decision — which providers
 * exist, how each one signs in, whether it is connected — is answered by the
 * `flows` route rather than baked in here. The page is a thin driver: it starts
 * a flow, shows the human where to go, and either waits for a pasted code or
 * polls at the interval the server tells it to.
 *
 * It never sees a token, because there is nothing in any of these responses to
 * see.
 */

import { REALTIME_SETTINGS_PATH } from "../orb/realtime-settings.ts";
import { VOICE_PROVIDERS_PATH } from "../voice/routes.ts";
import { PROVIDER_AUTH_BASE_PATH } from "./routes.ts";

const STYLES = `
  :root { color-scheme: light dark; }
  body { font: 15px/1.5 system-ui, sans-serif; margin: 0; padding: 2.5rem 1.5rem; }
  main { max-width: 34rem; margin: 0 auto; }
  h1 { font-size: 1.3rem; margin: 0 0 .25rem; }
  p.lede { margin: 0 0 2rem; opacity: .7; }
  section { border: 1px solid currentColor; border-radius: .5rem; padding: 1rem 1.25rem; margin-bottom: 1rem; }
  h2 { font-size: 1rem; margin: 0 0 .5rem; display: flex; justify-content: space-between; align-items: baseline; gap: 1rem; }
  .state { font-weight: 400; font-size: .85rem; opacity: .75; }
  .row { display: flex; gap: .5rem; flex-wrap: wrap; align-items: center; margin-top: .75rem; }
  button { font: inherit; padding: .35rem .8rem; border-radius: .35rem; cursor: pointer; }
  input { font: inherit; padding: .35rem .5rem; border-radius: .35rem; flex: 1 1 14rem; min-width: 0; }
  .step { margin-top: .75rem; font-size: .9rem; }
  .step[hidden] { display: none; }
  code { font-size: 1.05em; letter-spacing: .08em; }
  .error { color: #b3261e; font-size: .9rem; margin-top: .5rem; }
  .error:empty { display: none; }
  .rejected { color: #b3261e; opacity: 1; }
  .docs { font-size: .85rem; }
  .docs[hidden] { display: none; }
  details { border: 1px solid currentColor; border-radius: .5rem; padding: 1rem 1.25rem; margin-bottom: 1rem; }
  summary { cursor: pointer; font-size: 1rem; font-weight: 600; }
  #filter { display: block; width: 100%; box-sizing: border-box; margin: .75rem 0; }
  .entry { display: flex; gap: .5rem; flex-wrap: wrap; align-items: baseline; padding: .4rem 0; border-top: 1px solid currentColor; }
  .entry[hidden] { display: none; }
  .entry .name { flex: 1 1 10rem; }
  .entry .key-row { flex: 1 1 100%; }
  .voice { margin: 0 0 .35rem; font-size: .9rem; }
  .voice:last-child { margin-bottom: 0; }
  .field { margin-top: .75rem; }
  .field label { display: block; font-weight: 600; margin-bottom: .25rem; }
  select { font: inherit; padding: .35rem .5rem; border-radius: .35rem; min-width: 14rem; }
  .note { font-size: .85rem; opacity: .7; margin-top: .25rem; }
  .warning { color: #b3261e; font-size: .85rem; margin-top: .25rem; }
`;

const SCRIPT = String.raw`
const BASE = "__BASE__";

async function call(path, init) {
  const response = await fetch(BASE + path, {
    ...init,
    credentials: "same-origin",
    headers: init?.body ? { "content-type": "application/json" } : undefined,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || "Request failed.");
  return body;
}

const post = (path, payload) => call(path, { method: "POST", body: JSON.stringify(payload) });

/**
 * Two lists, from one answer.
 *
 * Everything the runtime can route to is offered, but a hundred and sixty
 * sign-in boxes is not an offer anybody can use. What gets a box of its own is
 * what the person is actually working with: the accounts this product can sign
 * into, plus anything already connected. The rest is a searchable catalogue,
 * one line each, a key field a click away.
 */
function render(providers) {
  const featured = providers.filter((p) => p.loginKind !== "api-key" || p.connected);
  const rest = providers.filter((p) => p.loginKind === "api-key" && !p.connected);

  document.getElementById("providers").replaceChildren(...featured.map(build));
  document.getElementById("catalogue").replaceChildren(...rest.map(buildEntry));
  document.getElementById("catalogue-count").textContent =
    rest.length + " more providers this agent can route to";
  applyFilter();
}

function stateText(provider) {
  if (!provider.connected) return "Not connected";
  if (provider.rejectedReason) return "Key rejected — " + provider.rejectedReason;
  return "Connected" + (provider.method === "api-key" ? " with an API key" : "");
}

function wireDocs(node, provider) {
  const docs = node.querySelector(".docs");
  docs.hidden = !provider.docUrl;
  if (provider.docUrl) {
    docs.href = provider.docUrl;
    docs.textContent = "Where to get a key";
  }
}

/** A key field and its Save button, wired to one provider. */
function wireKeyField(section, provider, fail) {
  section.querySelector(".save-key").addEventListener("click", guard(async () => {
    fail("");
    const field = section.querySelector(".key");
    await post("/api-key", { provider: provider.provider, key: field.value });
    field.value = "";
    // A provider that took the key and still refused to serve it comes back as
    // a rejection on the next read, which is where the page gets everything
    // else it says too.
    await refresh();
  }, fail));
}

const guard = (fn, fail) => (...args) => fn(...args).catch((problem) => fail(problem.message));

function build(provider) {
  const node = document.getElementById("provider-template").content.cloneNode(true);
  const section = node.querySelector("section");
  section.dataset.provider = provider.provider;
  section.querySelector(".name").textContent = provider.name;
  const state = section.querySelector(".state");
  state.textContent = stateText(provider);
  state.classList.toggle("rejected", Boolean(provider.rejectedReason));
  wireDocs(section, provider);
  // A provider with no flow this product owns gets no button that cannot start
  // anything: the key field is the whole offer, and it is an honest one.
  section.querySelector(".connect").hidden = provider.connected || provider.loginKind === "api-key";
  // A rejected key still needs replacing, so the field stays.
  section.querySelector(".key-row").hidden = provider.connected && !provider.rejectedReason;
  section.querySelector(".disconnect").hidden = !provider.connected;

  const error = section.querySelector(".error");
  const fail = (reason) => { error.textContent = reason; };

  section.querySelector(".connect").addEventListener("click", guard(async () => {
    fail("");
    await drive(section, provider, await post("/start", { provider: provider.provider }));
  }, fail));

  section.querySelector(".disconnect").addEventListener("click", guard(async () => {
    fail("");
    await post("/disconnect", { provider: provider.provider });
    await refresh();
  }, fail));

  wireKeyField(section, provider, fail);
  if (provider.rejectedReason) fail(provider.rejectedReason);

  return node;
}

/** One catalogue line: a name, and a key field that appears when asked for. */
function buildEntry(provider) {
  const node = document.getElementById("entry-template").content.cloneNode(true);
  const entry = node.querySelector(".entry");
  entry.dataset.provider = provider.provider;
  entry.dataset.search = (provider.name + " " + provider.provider).toLowerCase();
  entry.querySelector(".name").textContent = provider.name;
  wireDocs(entry, provider);

  const error = entry.querySelector(".error");
  const fail = (reason) => { error.textContent = reason; };

  entry.querySelector(".add-key").addEventListener("click", () => {
    const row = entry.querySelector(".key-row");
    row.hidden = !row.hidden;
    if (!row.hidden) entry.querySelector(".key").focus();
  });

  wireKeyField(entry, provider, fail);
  return node;
}

function applyFilter() {
  const query = document.getElementById("filter").value.trim().toLowerCase();
  for (const entry of document.querySelectorAll(".entry")) {
    entry.hidden = query.length > 0 && !entry.dataset.search.includes(query);
  }
}

async function drive(section, provider, session) {
  const step = section.querySelector(".step");
  step.hidden = false;
  section.querySelector(".auth-url").href = session.url;
  section.querySelector(".auth-url").textContent = session.url;
  section.querySelector(".user-code").textContent = session.userCode || "";
  section.querySelector(".paste-row").hidden = Boolean(session.userCode);

  if (session.userCode) {
    await poll(section, session);
    return;
  }

  section.querySelector(".submit-code").onclick = async () => {
    const code = section.querySelector(".code").value;
    const done = await post("/complete", { sessionId: session.sessionId, code });
    if (done.status === "failed") { section.querySelector(".error").textContent = done.error; return; }
    step.hidden = true;
    await refresh();
  };
}

async function poll(section, session) {
  let wait = session.nextPollMs || 2000;
  for (;;) {
    await new Promise((resume) => setTimeout(resume, wait));
    const result = await post("/poll", { sessionId: session.sessionId });
    if (result.status === "complete") { section.querySelector(".step").hidden = true; await refresh(); return; }
    if (result.status === "failed") { section.querySelector(".error").textContent = result.error; return; }
    wait = result.nextPollMs || wait;
  }
}

async function refresh() {
  render((await call("/flows")).providers);
  await refreshVoices();
  await refreshRealtime();
}

/**
 * The mouths this machine can wear. Rendered from what the server offers and
 * nothing else: a provider with no credential is not in the response, so there
 * is nothing here that decides whether to hide it.
 */
async function refreshVoices() {
  const list = document.getElementById("voices");
  const response = await fetch("__VOICE_PROVIDERS__", { credentials: "same-origin" });
  const { providers } = await response.json();

  if (!providers.length) {
    list.textContent = "Connect an account above to give the agent a voice.";
    return;
  }

  list.replaceChildren(...providers.map((provider) => {
    const row = document.createElement("p");
    row.className = "voice";
    row.dataset.provider = provider.provider;
    row.textContent = provider.usable
      ? provider.name + " — ready"
      : provider.name + " — " + provider.reason;
    return row;
  }));
}

document.getElementById("filter").addEventListener("input", applyFilter);

/**
 * The realtime model and speaking voice the orb uses. Both take effect on the
 * next conversation — the provider can't change them mid-socket — and the
 * page says so. The server ships a curated list, but a saved value not on it
 * (e.g. a model that was added or retired upstream) still appears and applies,
 * with a warning rather than a refusal.
 */
async function refreshRealtime() {
  const settings = await call("__REALTIME_SETTINGS__");

  document.getElementById("realtime-model").replaceChildren(
    ...settings.models.map((m) => new Option(m.name, m.name, false, m.name === settings.model)),
  );
  document.getElementById("realtime-voice").replaceChildren(
    ...settings.voices.map((v) => new Option(v.name, v.name, false, v.name === settings.voice)),
  );

  // An unknown-but-typed saved value — not on the curated list — still applies,
  // but the person should see that it isn't recognised.
  if (settings.model && !settings.models.some((m) => m.name === settings.model)) {
    document.getElementById("realtime-model").append(
      new Option(settings.model + " (unknown)", settings.model, true, true),
    );
    document.getElementById("model-warning").textContent =
      "The saved model " + settings.model + " is not in the known list. It may have been added or retired upstream.";
  } else {
    document.getElementById("model-warning").textContent = "";
  }
  if (settings.voice && !settings.voices.some((v) => v.name === settings.voice)) {
    document.getElementById("realtime-voice").append(
      new Option(settings.voice + " (unknown)", settings.voice, true, true),
    );
    document.getElementById("voice-warning").textContent =
      "The saved voice " + settings.voice + " is not in the known list.";
  } else {
    document.getElementById("voice-warning").textContent = "";
  }

  document.getElementById("realtime-model").value = settings.model || "";
  document.getElementById("realtime-voice").value = settings.voice || "";
}

document.getElementById("realtime-model").addEventListener("change", () =>
  saveRealtime("model", document.getElementById("realtime-model").value).catch(() => {}),
);
document.getElementById("realtime-voice").addEventListener("change", () =>
  saveRealtime("voice", document.getElementById("realtime-voice").value).catch(() => {}),
);

async function saveRealtime(field, value) {
  // Both fields are sent so one change doesn't clear the other.
  const payload = {};
  payload[field] = value;
  await call("__REALTIME_SETTINGS__", { method: "PUT", body: JSON.stringify(payload) });
  await refreshRealtime();
}

refresh().catch((problem) => { document.getElementById("providers").textContent = problem.message; });
`;

/** The settings page, whole. */
export function renderSettingsPage(basePath: string = PROVIDER_AUTH_BASE_PATH): string {
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Model accounts</title>
<style>${STYLES}</style>
<main>
  <h1>Model accounts</h1>
  <p class="lede">Sign in with your own Anthropic or OpenAI account, or paste a key for any other provider this agent can route to. Credentials stay on this machine.</p>
  <div id="providers"></div>
  <details>
    <summary id="catalogue-count">More providers</summary>
    <input id="filter" type="search" autocomplete="off" placeholder="Search providers">
    <div id="catalogue"></div>
  </details>
  <h1>Voice</h1>
  <p class="lede">Which account the agent speaks and listens with. Set <code>COMCON_VOICE_PROVIDER</code> to pick one; otherwise the connected one is used.</p>
  <section id="voices"></section>
  <h1>Realtime</h1>
  <p class="lede">The model and voice the orb uses over its live connection. These take effect on the next conversation — the provider cannot change them mid-socket.</p>
  <section>
    <div class="field">
      <label for="realtime-model">Model</label>
      <select id="realtime-model"></select>
      <p class="note">Takes effect on the next conversation.</p>
      <p class="warning" id="model-warning"></p>
    </div>
    <div class="field">
      <label for="realtime-voice">Speaking voice</label>
      <select id="realtime-voice"></select>
      <p class="note">Takes effect on the next conversation.</p>
      <p class="warning" id="voice-warning"></p>
    </div>
  </section>
</main>
<template id="provider-template">
  <section>
    <h2><span class="name"></span><span class="state"></span></h2>
    <div class="row">
      <button class="connect" type="button">Connect</button>
      <button class="disconnect" type="button">Disconnect</button>
      <a class="docs" target="_blank" rel="noreferrer" hidden></a>
    </div>
    <div class="row key-row">
      <input class="key" type="password" autocomplete="off" placeholder="…or paste an API key">
      <button class="save-key" type="button">Save key</button>
    </div>
    <div class="step" hidden>
      <p>Open <a class="auth-url" target="_blank" rel="noreferrer"></a> and approve the request.</p>
      <p>Enter this code: <code class="user-code"></code></p>
      <div class="row paste-row">
        <input class="code" type="text" autocomplete="off" placeholder="Paste the code you were given">
        <button class="submit-code" type="button">Finish</button>
      </div>
    </div>
    <p class="error" role="alert"></p>
  </section>
</template>
<template id="entry-template">
  <div class="entry">
    <span class="name"></span>
    <a class="docs" target="_blank" rel="noreferrer" hidden></a>
    <button class="add-key" type="button">Add a key</button>
    <div class="row key-row" hidden>
      <input class="key" type="password" autocomplete="off" placeholder="Paste an API key">
      <button class="save-key" type="button">Save key</button>
    </div>
    <p class="error" role="alert"></p>
  </div>
</template>
<script type="module">${SCRIPT.replace("__BASE__", basePath)
  .replace("__VOICE_PROVIDERS__", VOICE_PROVIDERS_PATH)
  .replace(/__REALTIME_SETTINGS__/g, REALTIME_SETTINGS_PATH)}</script>
</html>`;
}
