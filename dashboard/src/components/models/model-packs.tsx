"use client";

import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Field, Select } from "@/components/ui/select";
import type { ModelPacksView, PackProvider, PackRow } from "@/lib/hub";

/**
 * The packs this hub can think with, and the one it is thinking with now.
 *
 * The card the page used to have said what the pack was and nothing else, which
 * was honest while the pack was only ever declared in source. Now that the hub
 * accepts a choice, every control here changes something: a pack that cannot be
 * picked is shown with the reason it cannot rather than hidden, and a model
 * whose provider holds no key on this machine is never offered as if it would
 * work. No key, no offer — and no silent failure at the next turn.
 */

function ModelList(props: { tiers: readonly string[]; models: Record<string, string>; thinkingTier: string }) {
  return (
    <ul className="flex flex-col gap-1 text-sm">
      {props.tiers.map((tier) => (
        <li key={tier} className="flex items-center justify-between gap-3">
          <span className="text-muted capitalize">
            {tier}
            {tier === props.thinkingTier ? " · thinks" : ""}
          </span>
          <span className="truncate text-foreground">{props.models[tier] ?? "—"}</span>
        </li>
      ))}
    </ul>
  );
}

function PackCard(props: {
  pack: PackRow;
  tiers: readonly string[];
  thinkingTier: string;
  busy: boolean;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onDuplicate: (pack: PackRow) => void;
}) {
  const { pack } = props;
  return (
    <div className="rounded-lg border border-border bg-well/40 p-3">
      <div className="flex items-center gap-3">
        <span className="font-medium text-foreground">{pack.name}</span>
        <Badge variant="muted">{pack.source === "custom" ? "yours" : "built in"}</Badge>
        {pack.active ? <Badge variant="success">active</Badge> : null}
        <div className="ml-auto flex items-center gap-2">
          {pack.active ? null : (
            <Button
              variant="outline"
              disabled={!pack.selectable || props.busy}
              onClick={() => props.onSelect(pack.id)}
            >
              Use this pack
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={() => props.onDuplicate(pack)}>
            Duplicate
          </Button>
          {pack.source === "custom" ? (
            <Button
              variant="ghost"
              size="sm"
              disabled={props.busy}
              onClick={() => props.onDelete(pack.id)}
            >
              Delete
            </Button>
          ) : null}
        </div>
      </div>
      <div className="mt-2">
        <ModelList tiers={props.tiers} models={pack.models} thinkingTier={props.thinkingTier} />
      </div>
      {pack.reason ? (
        <p className="mt-2 text-xs text-muted" role="note">
          {pack.reason}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The model choices for one tier.
 *
 * A provider with no key on this machine still appears, with its models
 * disabled and its group saying why. Leaving it out entirely would answer the
 * question "can I run Gemini here?" with silence; offering it as if it worked
 * would answer it with a failure three clicks later.
 */
function ModelOptions(props: { providers: readonly PackProvider[] }) {
  return (
    <>
      <option value="">Choose a model…</option>
      {props.providers.map((provider) => (
        <optgroup
          key={provider.provider}
          label={provider.connected ? provider.name : `${provider.name} — no key on this machine`}
          disabled={!provider.connected}
        >
          {provider.models.map((model) => (
            <option key={model} value={model} disabled={!provider.connected}>
              {model}
            </option>
          ))}
        </optgroup>
      ))}
    </>
  );
}

function CreatePack(props: {
  view: ModelPacksView;
  draft: { name: string; models: Record<string, string> };
  busy: boolean;
  onDraft: (draft: { name: string; models: Record<string, string> }) => void;
  onCreate: (name: string, models: Record<string, string>) => void;
}) {
  const { view, draft } = props;
  const complete =
    draft.name.trim() !== "" && view.tiers.every((tier) => (draft.models[tier] ?? "") !== "");
  // Connected first: the models a person can actually pick should not be below
  // a scroll of ones they cannot.
  const providers = [...view.providers].sort(
    (a, b) => Number(b.connected) - Number(a.connected) || a.name.localeCompare(b.name),
  );

  return (
    <div className="rounded-lg border border-dashed border-border p-4">
      <p className="text-sm font-medium text-foreground">Make a pack</p>
      <p className="mt-1 text-xs text-muted">
        One model per tier, from the providers this machine holds an account with. The hub checks
        each one the same way it checks the pack it boots with.
      </p>
      <div className="mt-3 flex flex-col gap-3">
        <Field label="Name">
          <Input
            value={draft.name}
            aria-label="Pack name"
            placeholder="Cheap day"
            onChange={(event) => props.onDraft({ ...draft, name: event.target.value })}
          />
        </Field>
        {view.tiers.map((tier) => (
          <Field key={tier} label={tier === view.thinkingTier ? `${tier} (thinks)` : tier}>
            <Select
              aria-label={`${tier} model`}
              value={draft.models[tier] ?? ""}
              onChange={(event) =>
                props.onDraft({ ...draft, models: { ...draft.models, [tier]: event.target.value } })
              }
            >
              <ModelOptions providers={providers} />
            </Select>
          </Field>
        ))}
        <Button
          className="self-start"
          disabled={!complete || props.busy}
          onClick={() => props.onCreate(draft.name.trim(), draft.models)}
        >
          Create pack
        </Button>
      </div>
    </div>
  );
}

export function ModelPacksCard(props: {
  packs: ModelPacksView | null;
  /** The hub answered, and the answer was no. Shown verbatim. */
  refused?: string;
  /** The hub could not be asked at all. */
  unreachable?: string;
  busy: boolean;
  onSelect: (id: string) => void;
  onCreate: (name: string, models: Record<string, string>) => void;
  onDelete: (id: string) => void;
}) {
  const [draft, setDraft] = useState<{ name: string; models: Record<string, string> }>({
    name: "",
    models: {},
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg text-foreground">Model packs</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {props.unreachable ? (
          <p className="text-sm text-muted">The hub did not answer about packs: {props.unreachable}</p>
        ) : null}
        {props.refused ? (
          <p className="text-sm text-danger" role="alert">
            {props.refused}
          </p>
        ) : null}
        {props.packs === null ? (
          props.unreachable ? null : (
            <p className="text-sm text-muted">Asking the hub…</p>
          )
        ) : (
          <>
            <p className="text-sm text-muted">
              Thinking with <span className="text-foreground">{props.packs.active.thinking}</span>{" "}
              from <span className="text-foreground">{props.packs.active.name}</span>. A pack you
              pick answers the next thing you say.
            </p>
            {Object.entries(props.packs.overrides).map(([tier, variable]) => (
              <p key={tier} className="text-xs text-muted" role="note">
                {variable} is set on this machine, so the {tier} tier runs{" "}
                {props.packs?.active.models[tier]} whichever pack is picked.
              </p>
            ))}
            {props.packs.packs.map((pack) => (
              <PackCard
                key={pack.id}
                pack={pack}
                tiers={props.packs?.tiers ?? []}
                thinkingTier={props.packs?.thinkingTier ?? ""}
                busy={props.busy}
                onSelect={props.onSelect}
                onDelete={props.onDelete}
                onDuplicate={(source) =>
                  setDraft({ name: `${source.name} copy`, models: { ...source.models } })
                }
              />
            ))}
            <CreatePack
              view={props.packs}
              draft={draft}
              busy={props.busy}
              onDraft={setDraft}
              onCreate={(name, models) => {
                props.onCreate(name, models);
                setDraft({ name: "", models: {} });
              }}
            />
          </>
        )}
      </CardContent>
    </Card>
  );
}
