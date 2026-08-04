/**
 * Why a failure reason from somewhere else is not simply relayed.
 *
 * A failure reason is the one string on these surfaces that originates upstream
 * rather than here. The auth SDK builds some of them by interpolating the
 * provider's raw response body — `Token exchange failed: ${await res.text()}`
 * in the Anthropic exchange, and the poll status text in the Codex one. The
 * voice provider throws errors carrying whatever OpenAI wrote that minute. That
 * body is whatever the provider chose to send on a bad day, which is not a
 * thing we get to make promises about. Relaying it unexamined would make "no
 * response ever carries a token" a claim about somebody else's error
 * formatting.
 *
 * So the reason is trimmed to its first line, capped, and dropped entirely if
 * it looks like it is carrying a secret. What survives is enough to tell a
 * mistyped code from an expired one, or a dry wallet from a rate limit, which
 * is all a human needs.
 *
 * This lives outside `auth/` because two surfaces now depend on it and the
 * pattern is a security control. Two copies is one copy that can be taught
 * about a new token shape while the other quietly goes on missing it.
 */
const CREDENTIAL_SHAPED = /(access|refresh|id)[-_ ]?token|api[-_ ]?key|secret|bearer\s|code_verifier|eyJ[A-Za-z0-9_-]{10}|sk-[A-Za-z0-9_-]{10}/i;

export function safeReason(reason: string, fallback: string): string {
  const firstLine = reason.split("\n")[0]!.trim();
  if (firstLine.length === 0 || firstLine.length > 200) return fallback;
  return CREDENTIAL_SHAPED.test(firstLine) ? fallback : firstLine;
}
