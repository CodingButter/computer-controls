import { ComingSoon } from "@/components/shell/coming-soon";

/**
 * Placeholder until the accounts flows port lands (Phase 5). See audit's stub
 * for why a stub beats a missing route: the SPA fallback would serve Overview
 * here with the wrong sidebar pill lit.
 */
export default function AccountsPage() {
  return (
    <ComingSoon
      title="Accounts"
      blurb="Provider connections and voice settings land here in a later phase. Until then, the settings section under /chat still works."
    />
  );
}
