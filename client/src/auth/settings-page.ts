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
  .voice { margin: 0 0 .35rem; font-size: .9rem; }
  .voice:last-child { margin-bottom: 0; }
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

function render(providers) {
  const list = document.getElementById("providers");
  list.replaceChildren(...providers.map(build));
}

function build(provider) {
  const node = document.getElementById("provider-template").content.cloneNode(true);
  const section = node.querySelector("section");
  section.dataset.provider = provider.provider;
  section.querySelector(".name").textContent = provider.name;
  section.querySelector(".state").textContent = provider.connected
    ? "Connected" + (provider.method === "api-key" ? " with an API key" : "")
    : "Not connected";
  section.querySelector(".connect").hidden = provider.connected;
  section.querySelector(".key-row").hidden = provider.connected;
  section.querySelector(".disconnect").hidden = !provider.connected;

  const error = section.querySelector(".error");
  const fail = (reason) => { error.textContent = reason; };
  const guard = (fn) => (...args) => fn(...args).catch((problem) => fail(problem.message));

  section.querySelector(".connect").addEventListener("click", guard(async () => {
    fail("");
    await drive(section, provider, await post("/start", { provider: provider.provider }));
  }));

  section.querySelector(".disconnect").addEventListener("click", guard(async () => {
    fail("");
    await post("/disconnect", { provider: provider.provider });
    await refresh();
  }));

  section.querySelector(".save-key").addEventListener("click", guard(async () => {
    fail("");
    const field = section.querySelector(".key");
    await post("/api-key", { provider: provider.provider, key: field.value });
    field.value = "";
    await refresh();
  }));

  return node;
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
  <p class="lede">Sign in with your own Anthropic and OpenAI accounts. Credentials stay on this machine.</p>
  <div id="providers"></div>
  <h1>Voice</h1>
  <p class="lede">Which account the agent speaks and listens with. Set <code>COMCON_VOICE_PROVIDER</code> to pick one; otherwise the connected one is used.</p>
  <section id="voices"></section>
</main>
<template id="provider-template">
  <section>
    <h2><span class="name"></span><span class="state"></span></h2>
    <div class="row">
      <button class="connect" type="button">Connect</button>
      <button class="disconnect" type="button">Disconnect</button>
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
<script type="module">${SCRIPT.replace("__BASE__", basePath).replace(
  "__VOICE_PROVIDERS__",
  VOICE_PROVIDERS_PATH,
)}</script>
</html>`;
}
