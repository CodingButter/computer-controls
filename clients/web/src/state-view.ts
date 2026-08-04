/**
 * State view: render live desktop state received over the WebSocket.
 *
 * The server pushes two kinds of messages:
 *   { type: "connected", clientId }
 *   { type: "picture", windows: [...], activeWindowId }
 *   { type: "delta", changes: [...] }
 *
 * For milestone 1, the view maintains the full picture from "picture" messages
 * and re-renders on each update. Delta application is a follow-on (the server
 * already sends the full picture on reconnect, so the view is always correct).
 */

export interface DesktopWindow {
  windowId: string;
  applicationId: string;
  title: string;
  role: string;
  active: boolean;
}

export interface DesktopPicture {
  windows: DesktopWindow[];
  activeWindowId: string;
}

interface StateMessage {
  type: string;
  clientId?: string;
  windows?: DesktopWindow[];
  activeWindowId?: string;
  changes?: unknown[];
  code?: string;
  message?: string;
}

/**
 * Create a state-view controller bound to a container element.
 * Returns methods to ingest server messages.
 */
export function createStateView(container: HTMLElement) {
  let clientId: string | null = null;

  function render(picture: DesktopPicture) {
    const windows = picture.windows ?? [];
    if (windows.length === 0) {
      container.innerHTML = `<p class="state-empty">No windows visible on the desktop.</p>`;
      return;
    }

    const items = windows
      .map((w) => {
        const active = w.windowId === picture.activeWindowId;
        const cls = active ? "window-item active" : "window-item";
        const app = escapeHtml(w.applicationId);
        const title = escapeHtml(w.title);
        return `<li class="${cls}">
          <span class="app">${app}</span>
          <span class="title">${title}</span>
          ${active ? '<span class="badge">focused</span>' : ""}
        </li>`;
      })
      .join("");

    container.innerHTML = `<ul class="window-list">${items}</ul>`;
  }

  function setStatus(text: string, kind: "ok" | "err" = "ok") {
    const el = container.querySelector(".status-line");
    if (el) {
      el.textContent = text;
      el.className = `status-line ${kind}`;
    }
  }

  /**
   * Ingest a message from the WebSocket. Returns false if the message
   * indicates a fatal error.
   */
  function ingest(msg: StateMessage): boolean {
    switch (msg.type) {
      case "connected":
        clientId = msg.clientId ?? null;
        setStatus(`Connected as ${clientId ?? "session"}`);
        return true;

      case "picture":
        render({
          windows: msg.windows ?? [],
          activeWindowId: msg.activeWindowId ?? "",
        });
        return true;

      case "delta":
        // For milestone 1, deltas are informational only — the server
        // sends a fresh picture on reconnect. A follow-on can apply them.
        return true;

      case "error":
        setStatus(
          msg.message ?? `Error: ${msg.code ?? "unknown"}`,
          "err",
        );
        return false;

      default:
        return true;
    }
  }

  return { ingest, render, setStatus };
}

function escapeHtml(text: string): string {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}
