// The dashboard's palette, as named constants. The same values live as CSS
// variables in app/globals.css — theme.test.ts holds the two files together,
// because a palette that drifts apart quietly is how a page stops matching the
// approved designs without anyone deciding it should.
//
// Source of truth for the look: the approved generated designs in
// ~/Pictures/Dashboard Generated/ — dark navy ground, cyan accent, status pills.

export const THEME = {
  /** The navy ground everything sits on. */
  background: "#101b2d",
  /** Cards and panels: one step up from the ground. */
  card: "#132033",
  /** Recessed wells — the activity list, the sidebar rail. */
  well: "#0a1626",
  /** Primary text: the pale cyan-white of the designs. */
  foreground: "#e7f3f6",
  /** Secondary text. */
  muted: "#8ba3bb",
  /** The cyan accent: active nav pill, gauges, links. */
  accent: "#0de6f9",
  /** Status pills. */
  success: "#2fd573",
  warning: "#e8b93e",
  danger: "#ff5c5c",
  purple: "#a978f0",
  /** Hairlines between panels. */
  border: "#1e3048",
} as const;

export type ThemeToken = keyof typeof THEME;
