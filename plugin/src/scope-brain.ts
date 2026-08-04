/**
 * Which model a scope deserves.
 *
 * The daemon reports two numbers about a grant and has no opinion about models:
 * severity, how much damage a mistake inside the scope can do, and breadth, how
 * much of the desktop the work spans. Those are facts. Turning them into a model
 * is a client decision, and it lives here.
 *
 * The two dimensions are not the same risk wearing two hats. Severity is damage:
 * a single submit button is one element and no model will lose track of it, but
 * pressing it wrongly cannot be taken back. Breadth is competence: forty
 * read-only elements across two applications cannot hurt anybody, and a small
 * model will still half-finish the job and report it done. Confusing them means
 * paying for the wrong thing — a big model guarding one button, or a cheap one
 * shepherding forty elements.
 *
 * The tiers here are deliberately abstract. This module says how much thinking
 * the work needs; which model that is depends on what the client author has and
 * what it costs them, and that mapping belongs to them.
 */

import type { GrantScopeResult } from "./protocol.generated.ts";

/** How much damage a mistake within the scope can cause. */
export interface ScopeSeverity {
  /** Highest operation class held: observe=0, edit=1, activate=2, submit=3, destructive=4. */
  rank: number;
  /** Whether the scope contains a class whose mistakes cannot be taken back. */
  irreversible: boolean;
}

/** How wide a net the scope casts. */
export interface ScopeBreadth {
  /** Distinct applications the scope spans. */
  applications: number;
  /** Element-anchored permissions handed out. Zero until scope anchors ship. */
  anchors: number;
  /** Whether the scope names no applications at all, and so spans every one there is. */
  unbounded: boolean;
}

/**
 * How much thinking the work needs, in ascending order.
 *
 * Not model names. A client author maps these onto whatever they actually run.
 */
export type BrainTier = "minimal" | "standard" | "heavy";

const TIERS: readonly BrainTier[] = ["minimal", "standard", "heavy"] as const;

export interface BrainChoice {
  tier: BrainTier;
  /** Which dimension drove the choice, for the audit trail and for the human reading it. */
  reason: string;
}

/** Damage demand: submit is the cliff. */
function severityDemand(severity: ScopeSeverity): number {
  if (severity.irreversible || severity.rank >= 3) return 2;
  return severity.rank >= 1 ? 1 : 0;
}

/**
 * Competence demand: how many separate things there are to keep track of.
 *
 * A scope that named nothing is the widest one available, not the narrowest.
 * Its count is a floor rather than a total, so it goes straight to the top
 * instead of being added up.
 */
function breadthDemand(breadth: ScopeBreadth): number {
  if (breadth.unbounded) return 2;
  const spread = breadth.applications + breadth.anchors;
  if (spread >= 5) return 2;
  return spread >= 2 ? 1 : 0;
}

/**
 * Pick a tier from the two numbers.
 *
 * The higher demand wins rather than the two being averaged: a scope that is
 * dangerous but narrow is still dangerous, and one that is harmless but sprawling
 * will still be dropped halfway by something too small to hold it.
 */
export function selectBrain(severity: ScopeSeverity, breadth: ScopeBreadth): BrainChoice {
  const damage = severityDemand(severity);
  const competence = breadthDemand(breadth);
  const demand = Math.max(damage, competence);
  const tier = TIERS[demand]!;

  let reason: string;
  if (damage > competence) {
    reason = severity.irreversible
      ? "severity: the scope holds a class whose mistakes cannot be taken back"
      : `severity: highest operation class held ranks ${severity.rank}`;
  } else if (competence > damage) {
    reason = breadth.unbounded
      ? "breadth: the scope names no applications, so it spans every one there is"
      : `breadth: ${breadth.applications} applications and ${breadth.anchors} anchors to keep track of`;
  } else {
    reason = `severity rank ${severity.rank} and breadth ${breadth.applications + breadth.anchors} both ask for ${tier}`;
  }

  return { tier, reason };
}

/**
 * The same choice, made from whatever the daemon just said.
 *
 * A daemon older than this field reports neither number. Assuming the smallest
 * scope there would be the wrong way round — an unknown scope is not a safe one —
 * so an unreported scope is treated as needing the most thinking, and the reason
 * says why rather than leaving a caller to wonder at the bill.
 */
export function brainFromGrant(result: GrantScopeResult): BrainChoice {
  if (!result.severity || !result.breadth) {
    return {
      tier: "heavy",
      reason: "unknown: this service does not report scope severity and breadth",
    };
  }
  return selectBrain(result.severity, result.breadth);
}
