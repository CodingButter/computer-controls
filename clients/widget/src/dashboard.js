/**
 * The one page this process will ever ask a browser to open.
 *
 * The dashboard is the hub's settings page, and opening it is a shell-level
 * action: it hands a loopback URL to the desktop's browser and forgets about
 * it. It does not travel the hub socket, because the socket carries the closed
 * gesture vocabulary and "show me a web page" is not one of the things a face
 * asks the hub for.
 *
 * The address is built here rather than passed in, for the same reason the
 * socket's is: an `openExternal` that took a URL from the page would be a
 * transparent, always-on-top window that opens arbitrary links, which is a
 * phishing surface with a nice animation. The host is a constant and the path
 * is a constant; the port is the only variable, and a port does not change
 * which machine the browser reaches.
 */

const HUB_HOST = "127.0.0.1";
const DASHBOARD_PATH = "/settings/accounts";

/**
 * @param {number} port
 * @returns {string | null} null when the port is not a port, so nothing opens
 */
export function dashboardUrl(port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return `http://${HUB_HOST}:${port}${DASHBOARD_PATH}`;
}
