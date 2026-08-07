/**
 * A framework-free navigation drawer for the hub's standalone pages.
 *
 * The orb and chat pages are hand-written HTML served from the hub's static
 * root. They bypass the dashboard's Next.js shell, so they have no sidebar —
 * and until this module, no way back to anything but the browser's back button.
 *
 * This module fetches the hub's single nav source (GET /api/nav), renders a
 * small toggle button and a slide-in overlay, and marks the current page
 * active. No framework, no bundler, no dependencies — the orb page holds a
 * live WebGL context and a realtime socket, and pulling a framework in to draw
 * nine links is exactly the cost the issue forbids.
 *
 * The DOM-free seams (`isActiveNav`, `markActive`) are exported so the test
 * suite can exercise them without a DOM — the same pattern orb.js uses.
 */

/**
 * Whether a nav entry is the one the visitor is on.
 *
 * Exact match for the root, prefix match for the rest — the same semantics the
 * hub's isActive uses. Duplicated here as a three-line algorithm because the
 * standalone pages cannot import hub source at runtime; the data (the entries)
 * is single-sourced through the endpoint, the algorithm is not the drift risk.
 */
export function isActiveNav(pathname, href) {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(href + "/");
}

/**
 * Stamps each entry with an `active` flag for the given pathname.
 * Pure — no DOM, testable in any environment.
 */
export function markActive(entries, pathname) {
  return entries.map((entry) => ({
    ...entry,
    active: isActiveNav(pathname, entry.href),
  }));
}

/**
 * Mounts the toggle button and overlay. Fetches /api/nav, builds links, wires
 * open/close. All styles are injected via a scoped <style> block so nothing in
 * the host page is depended on or overwritten.
 */
export async function initNavDrawer({ mount, currentPath }) {
  if (typeof document === "undefined") return;

  const pathname = currentPath || (typeof location !== "undefined" ? location.pathname : "/");

  let res;
  try {
    res = await fetch("/api/nav");
  } catch {
    // The hub is unreachable — the page worked before with zero nav, and still
    // does. A silent toggle that opens to nothing is worse than no toggle, so
    // we do not mount one.
    return;
  }
  if (!res.ok) return;

  const body = await res.json();
  const entries = Array.isArray(body?.entries) ? body.entries : [];
  if (entries.length === 0) return;

  const marked = markActive(entries, pathname);

  mount.appendChild(styleBlock());

  const toggle = makeToggle();
  const scrim = makeScrim();
  const panel = makePanel(marked);

  mount.appendChild(toggle);
  mount.appendChild(scrim);
  mount.appendChild(panel);

  const open = () => {
    panel.setAttribute("data-open", "true");
    scrim.setAttribute("data-open", "true");
    toggle.setAttribute("aria-expanded", "true");
  };
  const close = () => {
    panel.setAttribute("data-open", "false");
    scrim.setAttribute("data-open", "false");
    toggle.setAttribute("aria-expanded", "false");
  };

  toggle.addEventListener("click", () => {
    if (panel.getAttribute("data-open") === "true") close();
    else open();
  });
  scrim.addEventListener("click", close);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
  });
}

function styleBlock() {
  const style = document.createElement("style");
  style.textContent = `
    .cc-nav-toggle {
      position: fixed;
      top: 16px;
      left: 16px;
      z-index: 3;
      padding: 8px 14px;
      border-radius: 8px;
      border: 1px solid #2b2e44;
      background: #171926;
      color: #b9bbd4;
      font: 15px/1.5 ui-sans-serif, system-ui, sans-serif;
      cursor: pointer;
      transition: background 200ms ease, color 200ms ease;
    }
    .cc-nav-toggle:hover { background: #1f2233; color: #e8e8ef; }

    .cc-nav-overlay {
      position: fixed;
      inset: 0 0 0 auto;
      width: min(280px, 88vw);
      background: #101119;
      border-left: 1px solid #232535;
      transform: translateX(-100%);
      transition: transform 260ms ease;
      display: flex;
      flex-direction: column;
      z-index: 2;
    }
    .cc-nav-overlay[data-open="true"] { transform: translateX(0); }

    .cc-nav-overlay nav {
      flex: 1;
      overflow-y: auto;
      padding: 12px;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .cc-nav-overlay a {
      display: block;
      padding: 9px 12px;
      border-radius: 8px;
      color: #b9bbd4;
      text-decoration: none;
      font-size: 14px;
      transition: background 150ms ease, color 150ms ease;
    }
    .cc-nav-overlay a:hover { background: #1a1c28; color: #e8e8ef; }
    .cc-nav-overlay a[data-active="true"] {
      background: rgba(124, 58, 237, 0.15);
      color: #c4b5fd;
      font-weight: 500;
    }

    .cc-nav-overlay header {
      padding: 16px 16px 8px;
      border-bottom: 1px solid #232535;
    }
    .cc-nav-overlay header strong { font-size: 16px; color: #e8e8ef; }
    .cc-nav-overlay header p { margin: 2px 0 0; font-size: 12px; color: #8a8ca6; }

    .cc-nav-scrim {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.4);
      opacity: 0;
      pointer-events: none;
      transition: opacity 260ms ease;
      z-index: 1;
    }
    .cc-nav-scrim[data-open="true"] { opacity: 1; pointer-events: auto; }

    @media (prefers-reduced-motion: reduce) {
      .cc-nav-overlay, .cc-nav-scrim { transition: none; }
    }
  `;
  return style;
}

function makeToggle() {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "cc-nav-toggle";
  btn.setAttribute("aria-label", "Open navigation");
  btn.setAttribute("aria-expanded", "false");
  btn.textContent = "☰";
  return btn;
}

function makeScrim() {
  const scrim = document.createElement("div");
  scrim.className = "cc-nav-scrim";
  scrim.setAttribute("data-open", "false");
  return scrim;
}

function makePanel(entries) {
  const panel = document.createElement("aside");
  panel.className = "cc-nav-overlay";
  panel.setAttribute("data-open", "false");
  panel.setAttribute("aria-label", "Navigation");

  const header = document.createElement("header");
  const title = document.createElement("strong");
  title.textContent = "computer controls";
  const sub = document.createElement("p");
  sub.textContent = "this machine";
  header.appendChild(title);
  header.appendChild(sub);
  panel.appendChild(header);

  const nav = document.createElement("nav");
  nav.setAttribute("aria-label", "Primary");
  for (const entry of entries) {
    const a = document.createElement("a");
    a.href = entry.href;
    a.textContent = entry.label;
    if (entry.active) a.setAttribute("data-active", "true");
    if (entry.external) {
      a.setAttribute("aria-label", `${entry.label} — the hub's ${entry.label.toLowerCase()} page`);
    }
    nav.appendChild(a);
  }
  panel.appendChild(nav);

  return panel;
}
