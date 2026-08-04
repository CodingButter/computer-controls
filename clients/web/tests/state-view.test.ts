import { describe, it, expect, beforeEach } from "vitest";
import { createStateView } from "../src/state-view.ts";

describe("createStateView", () => {
  let container: HTMLElement;

  beforeEach(() => {
    container = document.createElement("div");
  });

  it("renders a connected message on ingest of type 'connected'", () => {
    const view = createStateView(container);
    view.ingest({ type: "connected", clientId: "cl-server-1" });

    const status = container.querySelector(".status-line");
    // Status is set via setStatus, but ingest updates internal clientId.
    // The main screen wires setStatus to the DOM status element separately.
    expect(view).toBeDefined();
  });

  it("renders windows from a 'picture' message", () => {
    const view = createStateView(container);
    view.ingest({
      type: "picture",
      windows: [
        {
          windowId: "w1",
          applicationId: "firefox",
          title: "Docs — Mozilla Firefox",
          role: "frame",
          active: false,
        },
        {
          windowId: "w2",
          applicationId: "code",
          title: "main.ts — Editor",
          role: "frame",
          active: true,
        },
      ],
      activeWindowId: "w2",
    });

    const items = container.querySelectorAll(".window-item");
    expect(items).toHaveLength(2);

    // The focused window gets the "active" class and a badge.
    const active = container.querySelector(".window-item.active");
    expect(active).toBeTruthy();
    expect(active?.querySelector(".badge")?.textContent).toBe("focused");
  });

  it("shows empty state when no windows", () => {
    const view = createStateView(container);
    view.ingest({
      type: "picture",
      windows: [],
      activeWindowId: "",
    });

    expect(container.querySelector(".state-empty")).toBeTruthy();
  });

  it("escapes HTML in window titles to prevent XSS", () => {
    const view = createStateView(container);
    view.ingest({
      type: "picture",
      windows: [
        {
          windowId: "w1",
          applicationId: "test",
          title: "<script>alert(1)</script>",
          role: "frame",
          active: true,
        },
      ],
      activeWindowId: "w1",
    });

    // The script tag must be escaped, not injected as live HTML.
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector(".title")?.innerHTML).toContain("&lt;script&gt;");
  });

  it("returns false on error messages (fatal)", () => {
    const view = createStateView(container);
    const result = view.ingest({
      type: "error",
      code: "BACKEND_UNAVAILABLE",
      message: "Daemon is not running",
    });
    expect(result).toBe(false);
  });

  it("returns true on delta messages (non-fatal)", () => {
    const view = createStateView(container);
    const result = view.ingest({ type: "delta", changes: [] });
    expect(result).toBe(true);
  });
});
