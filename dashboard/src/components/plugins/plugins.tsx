import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { HubHealth, RefusedPlugin } from "@/lib/hub";

/**
 * The plugins page: what this hub admitted, what it turned away, and — for the
 * admitted — which of the session's tools came in with them.
 *
 * Everything here is read off `/api/health`. Nothing on this page enables or
 * disables anything: who owns the allowlist is a decision this hub has not
 * made yet, and a switch that silently did nothing would be worse than none.
 */

/**
 * The tool-name prefixes a plugin's tools are known to carry.
 *
 * Attribution is by prefix because the hub reports the session's tool names and
 * the plugin census separately, and never says which came from where. The
 * mappings that are known are written down; anything else falls back to the
 * plugin's own id, which is the convention a plugin that names its tools after
 * itself already follows. When neither matches, the plugin lists no tools —
 * an empty list is honest, a guessed one is not.
 */
const KNOWN_PREFIXES: Record<string, readonly string[]> = {
  "desktop-control": ["desktop_"],
  memorease: ["memory_", "memorease_"],
};

function prefixesFor(id: string): readonly string[] {
  return KNOWN_PREFIXES[id] ?? [`${id.replaceAll("-", "_")}_`];
}

export type AdmittedPlugin = { name: string; tools: readonly string[] };

/**
 * Which of the hub's tools each admitted plugin contributed.
 *
 * A tool two plugins could both claim is attributed to neither: the point of
 * the list is to be able to trust it, and a tie is exactly where a prefix
 * guess would start inventing.
 */
export function admittedPlugins(
  admitted: readonly string[],
  tools: readonly string[],
): readonly AdmittedPlugin[] {
  const claims = admitted.map((name) => ({ name, prefixes: prefixesFor(name) }));
  const claimed = (claim: { prefixes: readonly string[] }, tool: string) =>
    claim.prefixes.some((prefix) => tool.startsWith(prefix));

  return claims.map((claim) => ({
    name: claim.name,
    tools: tools.filter(
      (tool) =>
        claimed(claim, tool) &&
        !claims.some((other) => other.name !== claim.name && claimed(other, tool)),
    ),
  }));
}

function AdmittedCard(props: { plugin: AdmittedPlugin }) {
  const { plugin } = props;
  return (
    <Card data-testid="admitted-plugin">
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle className="text-base text-foreground">{plugin.name}</CardTitle>
        <Badge variant="success">admitted</Badge>
      </CardHeader>
      <CardContent>
        {plugin.tools.length === 0 ? (
          <p className="text-sm text-muted">
            No tool on this hub traces back to this plugin by name. It is mounted; which
            tools it contributed is not something the hub reports.
          </p>
        ) : (
          <ul className="flex flex-wrap gap-1.5">
            {plugin.tools.map((tool) => (
              <li key={tool}>
                <Badge variant="muted">{tool}</Badge>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function RefusedCard(props: { plugin: RefusedPlugin }) {
  const { plugin } = props;
  return (
    <Card data-testid="refused-plugin" className="border-warning/40">
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle className="text-base text-foreground">{plugin.name}</CardTitle>
        <Badge variant="warning">refused</Badge>
      </CardHeader>
      <CardContent>
        {/* A refusal the hub could not explain is the defect worth showing. */}
        <p className="text-sm text-muted">{plugin.reason ?? "refused, no reason given"}</p>
      </CardContent>
    </Card>
  );
}

export function PluginsPanel(props: { health: HubHealth }) {
  const { plugins, tools } = props.health;
  const admitted = admittedPlugins(plugins.admitted, tools);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-semibold text-foreground">Plugins</h1>
        <p className="text-sm text-muted">
          {admitted.length} admitted · {plugins.refused.length} refused
        </p>
      </div>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-medium text-muted">Admitted</h2>
        {admitted.length === 0 ? (
          <p className="text-sm text-muted">
            This hub mounted no plugins at all, which should not happen: the desktop
            plugin is how the agent reaches the machine.
          </p>
        ) : (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {admitted.map((plugin) => (
              <AdmittedCard key={plugin.name} plugin={plugin} />
            ))}
          </div>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-medium text-muted">Refused</h2>
        {plugins.refused.length === 0 ? (
          <p className="text-sm text-muted">
            Nothing installed on this machine was turned away. A plugin in neither list
            is one that is not installed here at all.
          </p>
        ) : (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {plugins.refused.map((plugin) => (
              <RefusedCard key={plugin.name} plugin={plugin} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
