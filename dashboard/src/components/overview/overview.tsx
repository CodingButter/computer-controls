import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { Fetched, HubHealth, OrbStatus } from "@/lib/hub";

/**
 * The Overview's cards, rendered pure from already-fetched data so the tests
 * can feed fixtures without a network. The page owns the fetching; this file
 * owns what the numbers look like.
 */

/** One stat card: a label, a big value, a pill saying how to feel about it. */
function StatCard(props: {
  title: string;
  value: string;
  pill: { text: string; variant: "success" | "warning" | "danger" | "muted" | "default" };
  detail?: string;
}) {
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle>{props.title}</CardTitle>
        <Badge variant={props.pill.variant}>{props.pill.text}</Badge>
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-semibold">{props.value}</div>
        {props.detail ? <p className="mt-1 text-sm text-muted">{props.detail}</p> : null}
      </CardContent>
    </Card>
  );
}

/**
 * An unreachable hub renders the truth, never a fake green card. The detail
 * names what failed so a person mid-setup has a thread to pull.
 */
export function UnreachableNotice(props: { detail: string }) {
  return (
    <Card className="border-danger/40">
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle>Hub</CardTitle>
        <Badge variant="danger">unreachable</Badge>
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-semibold">Hub unreachable</div>
        <p className="mt-1 text-sm text-muted">{props.detail}</p>
      </CardContent>
    </Card>
  );
}

export function Overview(props: {
  health: Fetched<HubHealth>;
  orb: Fetched<OrbStatus>;
}) {
  const { health, orb } = props;

  if (health.kind === "unreachable") {
    return (
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        <UnreachableNotice detail={health.detail} />
      </div>
    );
  }

  const h = health.data;

  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      <StatCard
        title="Hub"
        value={h.ok ? "Running" : "Degraded"}
        pill={h.ok ? { text: "healthy", variant: "success" } : { text: "degraded", variant: "warning" }}
        detail={h.desktopScope ? `desktop scope: ${h.desktopScope}` : undefined}
      />
      <OrbCard orb={orb} />
      <StatCard
        title="Model pack"
        value={h.model?.pack ?? "none declared"}
        pill={h.model ? { text: "declared", variant: "success" } : { text: "missing", variant: "warning" }}
        detail={
          h.model
            ? Object.entries(h.model.tiers)
                .map(([tier, model]) => `${tier}: ${model}`)
                .join(" · ")
            : undefined
        }
      />
      <StatCard
        title="Plugins"
        value={`${h.plugins.admitted.length} admitted`}
        pill={
          h.plugins.refused.length > 0
            ? { text: `${h.plugins.refused.length} refused`, variant: "warning" }
            : { text: "all admitted", variant: "success" }
        }
        detail={[
          h.plugins.admitted.join(", "),
          h.plugins.refused.length > 0 ? `refused: ${h.plugins.refused.join(", ")}` : "",
        ]
          .filter(Boolean)
          .join(" — ")}
      />
      <StatCard
        title="Tools"
        value={String(h.tools.length)}
        pill={{ text: "minted", variant: "default" }}
        detail="tools the hub's agent may call"
      />
      <VoiceCard voice={h.voice} />
    </div>
  );
}

function OrbCard(props: { orb: Fetched<OrbStatus> }) {
  const { orb } = props;
  if (orb.kind === "unreachable") {
    return (
      <StatCard
        title="Orb"
        value="Unreachable"
        pill={{ text: "unreachable", variant: "danger" }}
        detail={orb.detail}
      />
    );
  }
  if (!orb.data.enabled) {
    // A refused orb states its reason — the same words the orb page uses.
    return (
      <StatCard
        title="Orb"
        value="Off"
        pill={{ text: "disabled", variant: "muted" }}
        detail={orb.data.reason}
      />
    );
  }
  return (
    <StatCard
      title="Orb"
      value={orb.data.state}
      pill={
        orb.data.state === "idle"
          ? { text: `gate: ${orb.data.gate}`, variant: "muted" }
          : { text: `gate: ${orb.data.gate}`, variant: "success" }
      }
      detail="live voice face"
    />
  );
}

function VoiceCard(props: { voice: HubHealth["voice"] }) {
  const { voice } = props;
  if (!voice) {
    return (
      <StatCard title="Voice" value="Not configured" pill={{ text: "absent", variant: "muted" }} />
    );
  }
  if (!voice.enabled) {
    return (
      <StatCard
        title="Voice"
        value="Off"
        pill={{ text: "disabled", variant: "muted" }}
        detail={voice.reason}
      />
    );
  }
  return <StatCard title="Voice" value="Enabled" pill={{ text: "ready", variant: "success" }} />;
}
