"use client";

import { useState } from "react";

import { ModelPacksCard } from "@/components/models/model-packs";
import { ProviderLogo } from "@/components/models/provider-logo";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Field, Select } from "@/components/ui/select";
import type {
  CatalogEntry,
  LoginFlow,
  ModelPacksView,
  ProviderFlow,
  RealtimeSettings,
  VoiceProvider,
} from "@/lib/hub";
import { cn } from "@/lib/utils";

/**
 * The models page: the providers this machine holds accounts with, the pack
 * this build runs, and the voices those credentials can wear — the same
 * configuration surface Factory exposes, in this dashboard's own clothes.
 *
 * Rendered from what the hub offers and nothing else. There is no token in
 * any of these props, because there is none in any of the answers they came
 * from — the same property the old settings page kept, carried over intact.
 */

function ConnectionPill(props: { provider: ProviderFlow }) {
  const { provider } = props;
  if (!provider.connected) return <Badge variant="muted">Not connected</Badge>;
  return (
    <Badge variant="success">
      {provider.method === "api-key" ? "Connected with an API key" : "Connected"}
    </Badge>
  );
}

/** The paste-a-key row, the only path a provider without a sign-in flow has. */
function ApiKeyRow(props: { provider: ProviderFlow; onSaveKey: (key: string) => void }) {
  const [key, setKey] = useState("");
  return (
    <div className="flex items-center gap-2">
      <Input
        variant="pill"
        type="password"
        value={key}
        onChange={(event) => setKey(event.target.value)}
        placeholder="…or paste an API key"
        aria-label={`${props.provider.name} API key`}
        className="w-56"
      />
      <Button
        variant="outline"
        disabled={key.trim() === ""}
        onClick={() => {
          props.onSaveKey(key.trim());
          setKey("");
        }}
      >
        Save key
      </Button>
    </div>
  );
}

/**
 * A sign-in in progress. Two shapes, because there are two flows: a device
 * code the person types into the provider's page while we poll, and an
 * authorization code they paste back here.
 */
function FlowPanel(props: {
  flow: LoginFlow;
  error?: string;
  onSubmitCode: (code: string) => void;
  onCancel: () => void;
}) {
  const { flow, error } = props;
  const [code, setCode] = useState("");
  return (
    <div className="mt-3 flex flex-col gap-2 rounded-lg border border-accent/40 bg-accent/5 p-3">
      {flow.instructions ? <p className="text-sm text-muted">{flow.instructions}</p> : null}
      {flow.url ? (
        <a
          href={flow.url}
          target="_blank"
          rel="noreferrer noopener"
          className="text-sm text-accent underline"
        >
          Open the authorization page
        </a>
      ) : null}
      {flow.userCode ? (
        <div className="flex items-center gap-2 text-sm">
          <span className="text-muted">Code:</span>
          <Badge variant="default">{flow.userCode}</Badge>
          <span className="text-muted" role="status">
            Waiting for authorization…
          </span>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <Input
            variant="pill"
            value={code}
            onChange={(event) => setCode(event.target.value)}
            placeholder="Paste the code from the authorization page"
            aria-label="Authorization code"
            className="w-72"
          />
          <Button
            variant="outline"
            disabled={code.trim() === ""}
            onClick={() => props.onSubmitCode(code.trim())}
          >
            Finish
          </Button>
        </div>
      )}
      {error ? (
        <p className="text-sm text-danger" role="alert">
          {error}
        </p>
      ) : null}
      <Button variant="ghost" size="sm" className="self-start px-0 underline" onClick={props.onCancel}>
        Cancel
      </Button>
    </div>
  );
}

function ProviderRow(props: {
  provider: ProviderFlow;
  flow?: LoginFlow;
  error?: string;
  onConnect: (provider: string) => void;
  onDisconnect: (provider: string) => void;
  onSaveKey: (provider: string, key: string) => void;
  onSubmitCode: (code: string) => void;
  onCancelFlow: () => void;
}) {
  const { provider, flow } = props;
  const hasSignIn = provider.loginKind !== "api-key";
  return (
    <div className="rounded-lg border border-border bg-well/40 p-3">
      <div className="flex items-center gap-3">
        <ProviderLogo provider={provider.provider} name={provider.name} />
        <div className="flex min-w-0 flex-col">
          <span className="font-medium text-foreground">{provider.name}</span>
          <span className="text-xs text-muted">
            {provider.loginKind === "api-key" ? "API key" : "Sign in with your own account"}
          </span>
        </div>
        <div className="ml-auto flex items-center gap-3">
          <ConnectionPill provider={provider} />
          {provider.connected ? (
            <Button variant="outline" onClick={() => props.onDisconnect(provider.provider)}>
              Disconnect
            </Button>
          ) : (
            <>
              {hasSignIn ? (
                <Button onClick={() => props.onConnect(provider.provider)}>Connect</Button>
              ) : null}
              <ApiKeyRow
                provider={provider}
                onSaveKey={(key) => props.onSaveKey(provider.provider, key)}
              />
            </>
          )}
        </div>
      </div>
      {flow ? (
        <FlowPanel
          flow={flow}
          error={props.error}
          onSubmitCode={props.onSubmitCode}
          onCancel={props.onCancelFlow}
        />
      ) : null}
    </div>
  );
}

/**
 * A voice lane. The list is the hub's answer verbatim: a provider with no
 * credential is not in it, so there is nothing here that decides to hide one.
 * Which one speaks is chosen by the environment today, so this shows the
 * choice rather than pretending to make it.
 */
function VoiceLane(props: { title: string; blurb: string; providers: readonly VoiceProvider[] }) {
  const usable = props.providers.filter((entry) => entry.usable);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base text-foreground">{props.title}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {props.providers.length === 0 ? (
          <p className="text-sm text-muted">Connect an account above to give the agent a voice.</p>
        ) : (
          <ul className="flex flex-col gap-1 text-sm">
            {props.providers.map((entry) => (
              <li key={entry.provider} className="flex items-start justify-between gap-3">
                <span className={cn("shrink-0", entry.usable ? "text-foreground" : "text-muted")}>
                  {entry.name}
                </span>
                {entry.usable ? (
                  <Badge variant="success">ready</Badge>
                ) : (
                  <span className="text-right text-xs text-muted">{entry.reason ?? "unavailable"}</span>
                )}
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs text-muted">
          {props.blurb}
          {usable.length > 0
            ? " Set COMCON_VOICE_PROVIDER to pick one; otherwise the connected one is used."
            : ""}
        </p>
      </CardContent>
    </Card>
  );
}

/**
 * A picker over a curated catalog that still shows a value the catalog does
 * not name.
 *
 * The saved value is offered as an option even when the hub does not recognise
 * it, because it is what the file holds and what the orb will send. A picker
 * that dropped it would show a person a setting other than the one they are
 * running — the shape of the bug #129 was filed about.
 */
function CatalogSelect(props: {
  label: string;
  value: string | undefined;
  catalog: readonly CatalogEntry[];
  defaultLabel: string;
  busy: boolean;
  onChange: (value: string) => void;
}) {
  const known = props.catalog.some((entry) => entry.name === props.value);
  return (
    <Field label={props.label}>
      <Select
        aria-label={props.label}
        disabled={props.busy}
        value={props.value ?? ""}
        onChange={(event) => props.onChange(event.target.value)}
      >
        <option value="">{props.defaultLabel}</option>
        {props.catalog.map((entry) => (
          <option key={entry.name} value={entry.name}>
            {entry.name}
          </option>
        ))}
        {props.value !== undefined && !known ? (
          <option value={props.value}>{props.value} (not in this list)</option>
        ) : null}
      </Select>
    </Field>
  );
}

/**
 * Which provider the orb opens its socket to, which model answers on it, and
 * which voice it wears.
 *
 * The provider picker is still inert: the hub reports which lanes exist and
 * whether they are usable, and nothing accepts a choice between them yet. It
 * shows the lane the orb would open today, with the reason when that lane is
 * not usable, rather than a control that silently does nothing.
 *
 * The model and voice pickers are live against the hub's settings file. A
 * change takes effect on the orb's next conversation, not mid-sentence — the
 * settings are read when a socket is dialled, and reaching into a running
 * conversation to swap the voice underneath somebody mid-reply is a worse
 * behaviour than waiting for them to finish.
 */
function RealtimeVoiceCard(props: {
  providers: readonly VoiceProvider[];
  realtime?: RealtimeSettings;
  realtimeError?: string;
  busy: boolean;
  onChooseModel: (model: string) => void;
  onChooseVoice: (voice: string) => void;
}) {
  const lanes = props.providers.filter((entry) => entry.lane === "realtime");
  // The one the orb would open today: a usable lane if there is one, otherwise
  // the first offered — with its reason shown rather than swallowed.
  const current = lanes.find((entry) => entry.usable) ?? lanes[0];
  const settings = props.realtime;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base text-foreground">Realtime voice</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {lanes.length === 0 ? (
          <p className="text-sm text-muted">Connect an account above to give the orb a voice.</p>
        ) : (
          <>
            <Field label="Provider">
              <Select aria-label="Realtime voice provider" disabled value={current?.provider ?? ""}>
                {lanes.map((entry) => (
                  <option key={entry.provider} value={entry.provider}>
                    {entry.name}
                  </option>
                ))}
              </Select>
            </Field>
            {current && !current.usable ? (
              <p className="text-xs text-muted">{current.reason ?? "unavailable"}</p>
            ) : null}
          </>
        )}

        {settings ? (
          <>
            <CatalogSelect
              label="Model"
              value={settings.model}
              catalog={settings.models}
              defaultLabel="This build's default"
              busy={props.busy}
              onChange={props.onChooseModel}
            />
            <CatalogSelect
              label="Voice"
              value={settings.voice}
              catalog={settings.voices}
              defaultLabel="This build's default"
              busy={props.busy}
              onChange={props.onChooseVoice}
            />
            {settings.warnings.map((warning) => (
              <p key={warning} className="text-xs text-warning">
                {warning}
              </p>
            ))}
          </>
        ) : (
          <p className="text-xs text-muted">
            {props.realtimeError ?? "The hub did not answer for the realtime model and voice."}
          </p>
        )}
        {props.realtimeError && settings ? (
          <p className="text-xs text-danger">{props.realtimeError}</p>
        ) : null}

        <p className="text-xs text-muted">
          The socket the orb opens to listen and speak. A change here applies to the next
          conversation, not the one in progress.
        </p>
      </CardContent>
    </Card>
  );
}

export function ModelsPanel(props: {
  providers: readonly ProviderFlow[];
  voices: readonly VoiceProvider[];
  /** The packs, as the hub answers them. `null` while the answer is still in flight. */
  packs: ModelPacksView | null;
  /** The hub's own reason for refusing a pack change, shown where it was asked for. */
  packRefusal?: string;
  packUnreachable?: string;
  packBusy?: boolean;
  flow?: LoginFlow;
  error?: string;
  /** Absent when the hub did not answer for them; `realtimeError` says why. */
  realtime?: RealtimeSettings;
  realtimeError?: string;
  realtimeBusy?: boolean;
  onConnect: (provider: string) => void;
  onDisconnect: (provider: string) => void;
  onSaveKey: (provider: string, key: string) => void;
  onSubmitCode: (code: string) => void;
  onCancelFlow: () => void;
  onChooseRealtimeModel: (model: string) => void;
  onChooseRealtimeVoice: (voice: string) => void;
  onSelectPack: (id: string) => void;
  onCreatePack: (name: string, models: Record<string, string>) => void;
  onDeletePack: (id: string) => void;
}) {
  const { providers, voices, flow } = props;
  const unconnected = providers.filter((entry) => !entry.connected);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold text-foreground">Models</h1>
        <p className="text-sm text-muted">
          Providers, the pack this hub thinks with, and the voice the orb speaks with. Credentials
          stay on this machine.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg text-foreground">Model Providers</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {providers.map((provider) => (
            <ProviderRow
              key={provider.provider}
              provider={provider}
              flow={flow?.provider === provider.provider ? flow : undefined}
              error={flow?.provider === provider.provider ? props.error : undefined}
              onConnect={props.onConnect}
              onDisconnect={props.onDisconnect}
              onSaveKey={props.onSaveKey}
              onSubmitCode={props.onSubmitCode}
              onCancelFlow={props.onCancelFlow}
            />
          ))}
        </CardContent>
      </Card>

      <ModelPacksCard
        packs={props.packs}
        {...(props.packRefusal ? { refused: props.packRefusal } : {})}
        {...(props.packUnreachable ? { unreachable: props.packUnreachable } : {})}
        busy={props.packBusy === true}
        onSelect={props.onSelectPack}
        onCreate={props.onCreatePack}
        onDelete={props.onDeletePack}
      />

      <div className="grid gap-4 md:grid-cols-2">
        <RealtimeVoiceCard
          providers={voices}
          {...(props.realtime ? { realtime: props.realtime } : {})}
          {...(props.realtimeError ? { realtimeError: props.realtimeError } : {})}
          busy={props.realtimeBusy === true}
          onChooseModel={props.onChooseRealtimeModel}
          onChooseVoice={props.onChooseRealtimeVoice}
        />
        <VoiceLane
          title="Speech synthesis"
          blurb="One request, one answer: what the typed lane speaks with."
          providers={voices.filter((entry) => entry.lane === "http")}
        />
      </div>

      <div className="rounded-lg border border-dashed border-border p-4 text-sm text-muted">
        {unconnected.length === 0
          ? "Every provider this hub knows about is connected."
          : `Add a provider: ${unconnected.map((entry) => entry.name).join(", ")} ${
              unconnected.length === 1 ? "is" : "are"
            } still waiting above.`}
      </div>
    </div>
  );
}
