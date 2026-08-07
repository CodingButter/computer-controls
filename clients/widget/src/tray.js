import { Menu, Tray } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The part of Mastra CC that is always there.
 *
 * The face comes and goes — that is the point of it — so something else has
 * to be the honest, permanent indicator that the widget exists and what state
 * it is in. That is the tray icon: the orb mark while the widget is working,
 * and a visibly-muted grey variant while it is disabled, because a user who
 * hid the face must never have to wonder whether hidden means deaf. The icon
 * is the one pixel that never lies about it.
 *
 * What this file deliberately does not hold is any power of its own. The
 * menu's actions arrive from the main process as callbacks: no `app`, no
 * `shell`, no URL, and nothing a renderer could reach — the renderer is never
 * handed tray control, because a page that could disable its own indicator
 * would defeat the indicator. This file turns state into a menu and an icon,
 * and hands the clicks back.
 */

const here = path.dirname(fileURLToPath(import.meta.url));

/** @typedef {import("./tray-state.js").TrayState} TrayState */

/**
 * @typedef {{
 *   toggleAutoHide: () => void,
 *   toggleDisabled: () => void,
 *   toggleDemo: () => void,
 *   openDashboard: () => void,
 *   quit: () => void,
 * }} TrayActions
 */

/**
 * Which image the tray shows: the orb, or the muted orb while disabled.
 *
 * @param {boolean} disabled
 * @returns {string}
 */
export function trayIconFile(disabled) {
  return path.join(here, disabled ? "tray-orb-muted.png" : "tray-orb.png");
}

/**
 * What hovering the icon says. Names the disabled state out loud, for the
 * same reason the icon changes: hidden and off must never look alike.
 *
 * @param {boolean} disabled
 * @returns {string}
 */
export function trayTooltip(disabled) {
  return disabled ? "Mastra CC — widget disabled" : "Mastra CC";
}

/**
 * The menu, built from state every time state changes.
 *
 * Rebuilt rather than mutated so the menu can never drift from the state it
 * claims to describe: the checkbox is the stored boolean, and the second
 * item's label says which direction it will move — "Disable widget" while
 * enabled, "Enable widget" while disabled.
 *
 * @param {TrayState} state
 * @param {TrayActions} actions
 * @returns {Electron.MenuItemConstructorOptions[]}
 */
export function menuTemplateFor(state, actions) {
  return [
    {
      label: "Auto-hide",
      type: "checkbox",
      checked: state.autoHide,
      click: actions.toggleAutoHide,
    },
    {
      label: state.disabled ? "Enable widget" : "Disable widget",
      click: actions.toggleDisabled,
    },
    {
      // Named for what it costs, not for what it enables. Turning this on
      // makes the window one the desktop manages — findable in a screen
      // recorder and in this project's own window capture — and also one that
      // alt-tab can land on, which is why nobody should discover they left it
      // on. The restart is in the label because the window's kind is decided
      // when it is created and cannot be changed underneath a running face.
      label: "Demo mode (restarts the face)",
      type: "checkbox",
      checked: state.demo,
      click: actions.toggleDemo,
    },
    { type: "separator" },
    { label: "Open the dashboard", click: actions.openDashboard },
    { type: "separator" },
    { label: "Quit Mastra CC", click: actions.quit },
  ];
}

/**
 * Put the icon in the tray and keep it honest.
 *
 * Returns a `refresh` the owner calls with each new state; the icon, tooltip
 * and menu all follow from it. The Tray instance itself is also returned so
 * the caller can keep a reference — an unreferenced Tray is garbage-collected
 * out of the tray on some platforms, which would be a resident client that
 * quietly stopped being resident.
 *
 * @param {TrayState} state
 * @param {TrayActions} actions
 */
export function createTray(state, actions) {
  const tray = new Tray(trayIconFile(state.disabled));

  const refresh = (next) => {
    tray.setImage(trayIconFile(next.disabled));
    tray.setToolTip(trayTooltip(next.disabled));
    tray.setContextMenu(Menu.buildFromTemplate(menuTemplateFor(next, actions)));
  };
  refresh(state);

  return { tray, refresh };
}
