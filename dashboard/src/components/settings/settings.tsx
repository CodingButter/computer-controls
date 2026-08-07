"use client";

import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Field, Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import type {
  AutostartView,
  CapabilityStatus,
  ConfigObject,
  DesktopConfigView,
} from "@/lib/hub";
import { cn } from "@/lib/utils";

/**
 * The Settings page: one configuration object, seen at the depth the user picked.
 *
 * The ruling this file implements is that Easy, Standard and Advanced are
 * lenses, not tiers. Switching lens changes what is shown, never what is
 * stored, and nothing is hidden by being unrepresentable at a shallower depth.
 *
 * That ruling is kept by construction rather than by care. There is one list of
 * fields below, each carrying the shallowest depth that draws it, and a lens is
 * a filter over that list — not a component with its own copy of the form. A
 * field added once appears at its depth and every depth beneath it, and cannot
 * be added to Easy without also existing in Advanced, because there is only the
 * one list. Three hand-written forms is how the depths start to disagree about
 * what the configuration is, and the disagreement always shows up as somebody's
 * setting quietly disappearing.
 *
 * Each control writes exactly one leaf key. That is the second half of
 * losslessness: `putDesktopSettings` cannot accept a document, so no lens can
 * save the object as it understood it, and a key no lens draws survives because
 * nothing ever had the chance to omit it.
 */

export const DEPTHS = ["easy", "standard", "advanced"] as const;
export type Depth = (typeof DEPTHS)[number];

const DEPTH_RANK: Record<Depth, number> = { easy: 0, standard: 1, advanced: 2 };

export const DEPTH_BLURB: Record<Depth, string> = {
  easy: "The two or three things most people change, and nothing else.",
  standard: "What an agent may do, what it must ask about first, and how long that lasts.",
  advanced: "Every field in the file, the file's location, and anything else it contains.",
};

/** How a value is drawn. The daemon's vocabulary decides the options, never this file. */
type Control = "mode" | "classes" | "seconds" | "boolean" | "list" | "text";

type FieldSpec = {
  /** The owned leaf key, spelled exactly as the route names it. */
  key: string;
  label: string;
  /** The shallowest lens that draws this field. Deeper lenses draw it too. */
  depth: Depth;
  control: Control;
  help: string;
};

/**
 * Every field this surface can write, in the order a person meets them.
 *
 * The keys match the route's `owns` list. What is *absent* is load-bearing:
 * `scopes.applications` and `scopes.blockedApplications` are the Permissions
 * page's registry, so Easy links there instead of growing a second, competing
 * list of checkboxes that would race the first.
 */
export const FIELDS: readonly FieldSpec[] = [
  {
    key: "scopes.permissionsMode",
    label: "Which applications an agent may touch",
    depth: "easy",
    control: "mode",
    help: "Open lets an agent reach any application that is not blocked. Per-application permits nothing until you say so, one application at a time — including applications installed after you chose it.",
  },
  {
    key: "scopes.operationClasses",
    label: "What an agent may do",
    depth: "standard",
    control: "classes",
    help: "Observing is reading the screen. Editing changes a value, activating presses something, submitting sends it, and destructive is the one that cannot be taken back.",
  },
  {
    key: "scopes.confirmClasses",
    label: "What it must ask you about first",
    depth: "standard",
    control: "classes",
    help: "An operation in this list stops and waits for you, even when it is otherwise permitted.",
  },
  {
    key: "scopes.idleExpirySeconds",
    label: "How long a grant survives without you",
    depth: "standard",
    control: "seconds",
    help: "A permission granted during a conversation expires this long after you stop taking part, so walking away is the same as revoking it.",
  },
  {
    key: "sensitiveApplications",
    label: "Applications whose contents are redacted",
    depth: "advanced",
    control: "list",
    help: "Anything read from these never leaves the machine — it is removed before it can reach a model or an audit entry. One name per line.",
  },
  {
    key: "audit",
    label: "Keep an audit log",
    depth: "advanced",
    control: "boolean",
    help: "Every operation the daemon performs, recorded where you can read it.",
  },
  {
    key: "auditPath",
    label: "Where the audit log is written",
    depth: "advanced",
    control: "text",
    help: "Left empty, the daemon picks its own location.",
  },
] as const;

/** A lens is a filter over the one list. */
export function fieldsAtDepth(depth: Depth): readonly FieldSpec[] {
  return FIELDS.filter((field) => DEPTH_RANK[field.depth] <= DEPTH_RANK[depth]);
}

/** Read a dotted key out of the configuration object, without assuming the branch exists. */
export function readSetting(config: ConfigObject, key: string): unknown {
  const dot = key.indexOf(".");
  if (dot < 0) return config[key];
  const branch = config[key.slice(0, dot)];
  if (typeof branch !== "object" || branch === null || Array.isArray(branch)) return undefined;
  return (branch as ConfigObject)[key.slice(dot + 1)];
}

/**
 * The keys present in the file that no lens draws.
 *
 * Advanced claims to show the whole object, and a claim like that is only
 * honest if it survives a key this build has never heard of — a field from a
 * newer version, or one written by hand. They are shown, marked as not ours to
 * edit, and left exactly alone.
 */
export function undrawnKeys(config: ConfigObject): readonly string[] {
  const drawn = new Set(FIELDS.map((field) => field.key));
  const found: string[] = [];
  for (const [key, value] of Object.entries(config)) {
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      for (const leaf of Object.keys(value as ConfigObject)) {
        const path = `${key}.${leaf}`;
        if (!drawn.has(path)) found.push(path);
      }
      continue;
    }
    if (!drawn.has(key)) found.push(key);
  }
  return found;
}

function DepthPicker(props: { depth: Depth; onDepth: (depth: Depth) => void }) {
  return (
    <div className="flex flex-col gap-1">
      <div
        className="flex rounded-full border border-border bg-well p-0.5"
        role="group"
        aria-label="Depth"
      >
        {DEPTHS.map((depth) => (
          <button
            key={depth}
            type="button"
            aria-pressed={props.depth === depth}
            onClick={() => props.onDepth(depth)}
            className={cn(
              "rounded-full px-4 py-1 text-xs capitalize transition-colors",
              props.depth === depth
                ? "bg-accent font-medium text-well"
                : "text-muted hover:text-foreground",
            )}
          >
            {depth}
          </button>
        ))}
      </div>
      <p className="text-xs text-muted">{DEPTH_BLURB[props.depth]}</p>
    </div>
  );
}

/**
 * A text-shaped control commits when it loses focus, not on every keystroke.
 * Saving per character would mean a half-typed path is a saved path, and the
 * daemon re-reads this file the moment it changes.
 */
function Committed(props: {
  value: string;
  label: string;
  multiline?: boolean;
  onCommit: (value: string) => void;
}) {
  const [draft, setDraft] = useState(props.value);
  const commit = () => {
    if (draft !== props.value) props.onCommit(draft);
  };
  if (props.multiline) {
    return (
      <textarea
        aria-label={props.label}
        value={draft}
        rows={3}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        className="flex w-full rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      />
    );
  }
  return (
    <Input
      aria-label={props.label}
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
      }}
    />
  );
}

function ClassesControl(props: {
  label: string;
  vocabulary: readonly string[];
  selected: readonly string[];
  onChange: (next: string[]) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {props.vocabulary.map((name) => {
        const on = props.selected.includes(name);
        return (
          <button
            key={name}
            type="button"
            role="checkbox"
            aria-checked={on}
            aria-label={`${props.label}: ${name}`}
            onClick={() =>
              props.onChange(
                on
                  ? props.selected.filter((v) => v !== name)
                  : // Rebuilt in the vocabulary's own order rather than appended,
                    // so the saved list reads the same whichever order it was clicked.
                    props.vocabulary.filter((v) => props.selected.includes(v) || v === name),
              )
            }
            className={cn(
              "rounded-full border px-3 py-1 text-xs transition-colors",
              on
                ? "border-accent/40 bg-accent/15 text-accent"
                : "border-border bg-well text-muted hover:text-foreground",
            )}
          >
            {name}
          </button>
        );
      })}
    </div>
  );
}

function SettingField(props: {
  spec: FieldSpec;
  view: DesktopConfigView;
  onSave: (key: string, value: unknown) => void;
}) {
  const { spec, view, onSave } = props;
  const stored = readSetting(view.config, spec.key);
  const unset = stored === undefined;
  const save = (value: unknown) => onSave(spec.key, value);

  // The default is shown as the live value, never as an empty box: unset does
  // not mean nothing, it means thirty minutes, or observe-only, or audit on.
  const defaults = view.defaults;
  const value =
    stored ??
    (spec.key === "scopes.permissionsMode"
      ? defaults.permissionsMode
      : spec.key === "scopes.operationClasses"
        ? defaults.operationClasses
        : spec.key === "scopes.confirmClasses"
          ? defaults.confirmClasses
          : spec.key === "scopes.idleExpirySeconds"
            ? defaults.idleExpirySeconds
            : spec.key === "audit"
              ? defaults.audit
              : undefined);

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-3">
        <CardTitle className="text-foreground">{spec.label}</CardTitle>
        {unset ? <Badge variant="muted">Daemon default</Badge> : null}
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {spec.control === "mode" ? (
          <>
            <Field label="Mode">
              <Select
                aria-label={spec.label}
                value={String(value ?? defaults.permissionsMode)}
                onChange={(event) => save(event.target.value)}
              >
                {view.vocabulary.permissionsModes.map((mode) => (
                  <option key={mode} value={mode}>
                    {mode === "open" ? "Open — anything not blocked" : "Per-application"}
                  </option>
                ))}
              </Select>
            </Field>
            {value === "per-application" ? (
              <p className="text-xs text-muted">
                Which applications are permitted is decided on the{" "}
                <a className="text-accent underline" href="/permissions">
                  Permissions page
                </a>
                , one application at a time.
              </p>
            ) : (
              <p className="rounded-lg border border-warning/40 bg-warning/10 p-2 text-xs text-warning">
                Open mode permits every application you have not blocked, including ones installed
                later. Nothing an agent does can change this setting — only you, here.
              </p>
            )}
          </>
        ) : null}

        {spec.control === "classes" ? (
          <ClassesControl
            label={spec.label}
            vocabulary={view.vocabulary.operationClasses}
            selected={Array.isArray(value) ? (value as string[]) : []}
            onChange={(next) => save(next)}
          />
        ) : null}

        {spec.control === "seconds" ? (
          <Field label="Minutes">
            <Input
              aria-label={spec.label}
              type="number"
              min={0}
              defaultValue={Math.round(Number(value ?? defaults.idleExpirySeconds) / 60)}
              onBlur={(event) => {
                const minutes = Number(event.target.value);
                if (Number.isFinite(minutes) && minutes >= 0) save(Math.round(minutes * 60));
              }}
            />
          </Field>
        ) : null}

        {spec.control === "boolean" ? (
          <div className="flex items-center justify-between">
            <span className="text-sm text-muted">{value === false ? "Off" : "On"}</span>
            <Switch
              checked={value !== false}
              onCheckedChange={(next) => save(next)}
              aria-label={spec.label}
            />
          </div>
        ) : null}

        {spec.control === "list" ? (
          <Committed
            multiline
            label={spec.label}
            value={(Array.isArray(value) ? (value as string[]) : []).join("\n")}
            onCommit={(text) =>
              save(
                text
                  .split("\n")
                  .map((line) => line.trim())
                  .filter(Boolean),
              )
            }
          />
        ) : null}

        {spec.control === "text" ? (
          <Committed
            label={spec.label}
            value={typeof value === "string" ? value : ""}
            onCommit={(text) => save(text.trim() === "" ? null : text.trim())}
          />
        ) : null}

        <p className="text-xs text-muted">{spec.help}</p>
      </CardContent>
    </Card>
  );
}

/**
 * Start on boot — a real control that is deliberately not one of the fields above.
 *
 * The entry it edits lives in the desktop's own autostart directory, not in the
 * configuration object these lenses draw, so it is not a `FieldSpec` and never
 * appears in Advanced's list of the file's keys. It is drawn at every depth
 * because it is the first thing most people want and the last thing they should
 * have to go looking for.
 *
 * The toggle edits the person's own autostart entry through the hub, and the
 * session manager does the launching — nothing here starts a process. The state
 * drawn is always the hub's answer, never an optimistic flip: a switch showing
 * "on" while the disk said otherwise would be the page disagreeing with the
 * desktop about what happens at login. So the card holds no state of its own;
 * the page passes the hub's latest word and takes the press back.
 *
 * A refused change renders the hub's sentence verbatim beside the switch. The
 * hub is the only side that knows why, and a page that re-phrased it would be
 * inventing a second answer. Unsupported is the reason arm pairing uses: off
 * with a sentence, never a switch that fails when pressed.
 */
export function AutostartCard(props: {
  view?: AutostartView;
  refusal?: string;
  busy: boolean;
  onFlip: (enabled: boolean) => void;
}) {
  const { view } = props;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg text-foreground">Start on boot</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {view === undefined ? (
          <>
            <Badge variant="muted" className="self-start">
              Not reported
            </Badge>
            <p className="text-sm text-muted">
              The hub did not answer about start on boot. No switch is drawn, because a switch here
              would not know what it was changing.
            </p>
          </>
        ) : view.supported ? (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm text-muted">
                Start the Mastra CC widget when you sign in. Your desktop does the launching; this
                only writes the entry it reads.
              </p>
              <Switch
                checked={view.enabled}
                onCheckedChange={(next) => {
                  if (!props.busy) props.onFlip(next);
                }}
                aria-label="Start the widget on boot"
              />
            </div>
            {/* The file being edited, named, because it is the person's own. */}
            <p className="font-mono text-xs text-muted">{view.path}</p>
            {props.refusal === undefined ? null : (
              <p className="text-sm text-danger" role="alert">
                {props.refusal}
              </p>
            )}
          </>
        ) : (
          <>
            <Badge variant="muted" className="self-start">
              Not available here
            </Badge>
            <p className="text-sm text-muted">{view.reason}</p>
          </>
        )}
      </CardContent>
    </Card>
  );
}

/** The hub's other faces, reported honestly: status, and where they are actually controlled. */
function FacesCard(props: { voice?: CapabilityStatus; orb?: CapabilityStatus }) {
  const rows: readonly { name: string; href: string; status?: CapabilityStatus }[] = [
    { name: "Voice", href: "/chat", status: props.voice },
    { name: "Orb", href: "/orb", status: props.orb },
  ];
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-foreground">Voice and orb</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {rows.map((row) => (
          <div key={row.name} className="flex items-center justify-between gap-3">
            <a className="text-sm text-accent underline" href={row.href}>
              {row.name}
            </a>
            {row.status === undefined ? (
              <Badge variant="muted">Not reported</Badge>
            ) : row.status.enabled ? (
              <Badge variant="success">Running</Badge>
            ) : (
              <Badge variant="warning">{row.status.reason}</Badge>
            )}
          </div>
        ))}
        <p className="text-xs text-muted">
          These are the hub&apos;s own faces rather than settings in this file, so they are reported
          here and switched where they live. A toggle that wrote nothing would be worse than no
          toggle.
        </p>
      </CardContent>
    </Card>
  );
}

/** Advanced's closing card: the file itself, and everything in it no lens draws. */
function FileCard(props: { view: DesktopConfigView }) {
  const extra = undrawnKeys(props.view.config);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-foreground">The file</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <code className="block break-all rounded-lg bg-well p-2 text-xs text-muted">
          {props.view.path}
        </code>
        {props.view.exists ? null : (
          <p className="text-xs text-muted">
            This file does not exist yet. Every value above is the daemon&apos;s own default, and
            the file is written the first time you change one.
          </p>
        )}
        {extra.length > 0 ? (
          <div className="flex flex-col gap-2">
            <span className="text-sm text-muted">Also in this file, and left alone:</span>
            <ul className="flex flex-col gap-1">
              {extra.map((key) => (
                <li key={key} className="flex items-center justify-between gap-2 text-xs">
                  <code className="text-foreground">{key}</code>
                  <span className="text-muted">
                    {key === "scopes.applications" || key === "scopes.blockedApplications"
                      ? "the Permissions page owns this"
                      : "not a field this page knows"}
                  </span>
                </li>
              ))}
            </ul>
            <p className="text-xs text-muted">
              Shown because Advanced claims to show the whole object. Saving anything above leaves
              these exactly as they are, down to their order.
            </p>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

/** The banner a refusal gets: verbatim, and explicit that nothing was written. */
export function SettingsRefusedNotice(props: { detail: string }) {
  return (
    <div className="rounded-xl border border-danger/40 bg-danger/10 p-4 text-sm text-danger">
      <p className="font-medium">The hub refused that change.</p>
      <p className="mt-1 text-danger/90">{props.detail}</p>
      <p className="mt-2 text-xs text-danger/80">
        Nothing was written. This page will not overwrite a configuration it cannot read — one
        stray comma should cost you a save, never the file.
      </p>
    </div>
  );
}

export function SettingsPanel(props: {
  view: DesktopConfigView;
  depth: Depth;
  onDepth: (depth: Depth) => void;
  /** One leaf key and its new value. There is deliberately no whole-document save. */
  onSave: (key: string, value: unknown) => void;
  refusal?: string;
  voice?: CapabilityStatus;
  orb?: CapabilityStatus;
  /** Not a field in the configuration object — see `AutostartCard`. */
  autostart?: AutostartView;
  autostartRefusal?: string;
  autostartBusy: boolean;
  onFlipAutostart: (enabled: boolean) => void;
}) {
  const { view, depth } = props;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <h1 className="text-2xl font-semibold text-foreground">Settings</h1>
        <DepthPicker depth={depth} onDepth={props.onDepth} />
      </div>

      {props.refusal ? <SettingsRefusedNotice detail={props.refusal} /> : null}

      <div className="flex flex-col gap-3">
        {fieldsAtDepth(depth).map((spec) => (
          <SettingField key={spec.key} spec={spec} view={view} onSave={props.onSave} />
        ))}
        <AutostartCard
          view={props.autostart}
          refusal={props.autostartRefusal}
          busy={props.autostartBusy}
          onFlip={props.onFlipAutostart}
        />
        {depth === "easy" ? <FacesCard voice={props.voice} orb={props.orb} /> : null}
        {depth === "advanced" ? <FileCard view={view} /> : null}
      </div>

      <p className="text-xs text-muted">
        Easy, Standard and Advanced are three views of one configuration. Changing the view changes
        what you see, never what is stored — a value a shallower view does not draw is still there,
        and still in force.
      </p>
    </div>
  );
}
