import { ComingSoon } from "@/components/shell/coming-soon";

/**
 * Placeholder until the audit feed lands (Phase 6). It must exist even as a
 * stub: a missing route falls back to the exported index page, which renders
 * Overview with Overview's pill lit under /audit — a wrong answer twice.
 */
export default function AuditPage() {
  return (
    <ComingSoon
      title="Audit"
      blurb="The daemon's redacted audit feed lands here in a later phase."
    />
  );
}
