/**
 * The one place that knows the hub's API shapes — assembled from one file per
 * surface rather than kept in a single sheet.
 *
 * The split is not tidiness. Several pages are built at once, by people and
 * agents who never speak to each other, and a shared file is where their work
 * collides: two branches that both taught one file about a new route cannot be
 * merged in either order without a hand on the wheel. A page that owns its own
 * slice merges in any order, and the only shared line is the one export added
 * below.
 *
 * Adding a surface: write `./<surface>.ts`, import `fetchJson`/`Fetched` from
 * `./core`, and add one `export *` line here. Never widen another slice.
 */

export * from "./core";
export * from "./health";
export * from "./permissions";
export * from "./accounts";
export * from "./audit";
export * from "./devices";
export * from "./pairing";
export * from "./realtime";
export * from "./autostart";
export * from "./desktop-config";
export * from "./model-packs";
export * from "./wake";
