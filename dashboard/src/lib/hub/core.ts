/**
 * The pieces every slice shares: how a fetch is phrased, and how a failure is
 * phrased back.
 *
 * The dashboard is a static export — there is no server between it and the
 * hub, so everything is a client-side fetch against the same origin.
 */

/**
 * The page's honest states: data, or the named reason there is none. An
 * unreachable hub is a fact worth showing, never something to paper over
 * with a fake green card.
 */
export type Fetched<T> = { kind: "ok"; data: T } | { kind: "unreachable"; detail: string };

export function asStringArray(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

export async function fetchJson<T>(
  path: string,
  parse: (body: unknown) => T,
): Promise<Fetched<T>> {
  try {
    const response = await fetch(path);
    if (!response.ok) {
      return { kind: "unreachable", detail: `${path} answered ${response.status}` };
    }
    return { kind: "ok", data: parse(await response.json()) };
  } catch (error) {
    return {
      kind: "unreachable",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}
