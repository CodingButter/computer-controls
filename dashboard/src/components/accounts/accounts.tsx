"use client";

import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { LoginFlow, ProviderFlow, VoiceProvider } from "@/lib/hub";
import { cn } from "@/lib/utils";

/**
 * The accounts page per the approved design: model providers with their
 * connection state, the sign-in flow each provider actually has, and the
 * voices this machine's credentials can wear.
 *
 * Rendered from what the hub offers and nothing else. There is no token in
 * any of these props, because there is none in any of the answers they came
 * from — the same property the old settings page kept, carried over intact.
 */

function ProviderMark(props: { name: string }) {
  return (
    <span
      aria-hidden
      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent/15 text-sm font-semibold text-accent"
    >
      {props.name.charAt(0).toUpperCase()}
    </span>
  );
}

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
      <input
        type="password"
        value={key}
        onChange={(event) => setKey(event.target.value)}
        placeholder="…or paste an API key"
        aria-label={`${props.provider.name} API key`}
        className="w-56 rounded-full border border-border bg-well px-4 py-1.5 text-sm text-foreground placeholder:text-muted focus:outline-none focus:ring-1 focus:ring-accent"
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
          <input
            value={code}
            onChange={(event) => setCode(event.target.value)}
            placeholder="Paste the code from the authorization page"
            aria-label="Authorization code"
            className="w-72 rounded-full border border-border bg-well px-4 py-1.5 text-sm text-foreground placeholder:text-muted focus:outline-none focus:ring-1 focus:ring-accent"
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
      <button type="button" onClick={props.onCancel} className="self-start text-xs text-muted underline">
        Cancel
      </button>
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
        <ProviderMark name={provider.name} />
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

export function AccountsPanel(props: {
  providers: readonly ProviderFlow[];
  voices: readonly VoiceProvider[];
  flow?: LoginFlow;
  error?: string;
  onConnect: (provider: string) => void;
  onDisconnect: (provider: string) => void;
  onSaveKey: (provider: string, key: string) => void;
  onSubmitCode: (code: string) => void;
  onCancelFlow: () => void;
}) {
  const { providers, voices, flow } = props;
  const unconnected = providers.filter((entry) => !entry.connected);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold text-foreground">Accounts</h1>
        <p className="text-sm text-muted">
          Sign in with your own provider accounts. Credentials stay on this machine.
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

      <div className="grid gap-4 md:grid-cols-2">
        <VoiceLane
          title="Realtime voice"
          blurb="The socket the orb opens to listen and speak."
          providers={voices.filter((entry) => entry.lane === "realtime")}
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
