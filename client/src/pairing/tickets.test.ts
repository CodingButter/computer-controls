/**
 * The ticket is the whole consent story, so its properties are tested as
 * security controls rather than as behaviour: expiry, single use, and the fact
 * that nothing about a refusal tells the caller which part of the guess was
 * wrong.
 */

import { describe, expect, it } from "vitest";

import {
  DEFAULT_DEVICE_LABEL,
  MAX_LABEL_LENGTH,
  TICKET_TTL_MS,
  cleanLabel,
  createTicketMint,
} from "./tickets.ts";

/** A clock a test can move, so expiry is asserted rather than waited for. */
function fakeClock(start = 1_000_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

describe("a pairing ticket", () => {
  it("turns into a pairing exactly once", () => {
    const mint = createTicketMint();
    const ticket = mint.issue();

    expect(mint.redeem(ticket.code, "Jamie's phone")).toBe("Jamie's phone");
    // The second attempt is the one that matters: a QR photographed over a
    // shoulder must be worthless the moment the intended phone has used it.
    expect(mint.redeem(ticket.code, "A second phone")).toBeUndefined();
  });

  it("stops working on its own, so walking away is not leaving a door open", () => {
    const clock = fakeClock();
    const mint = createTicketMint(clock.now);
    const ticket = mint.issue();

    clock.advance(TICKET_TTL_MS - 1);
    expect(mint.outstanding()?.code).toBe(ticket.code);

    clock.advance(2);
    expect(mint.outstanding()).toBeUndefined();
    expect(mint.redeem(ticket.code, "Late phone")).toBeUndefined();
  });

  it("keeps only the code currently on the screen", () => {
    const mint = createTicketMint();
    const first = mint.issue();
    const second = mint.issue();

    // A hub with a queue of live codes is a hub where a forgotten press three
    // minutes ago is still a door.
    expect(mint.redeem(first.code, "Old code")).toBeUndefined();
    expect(mint.redeem(second.code, "Current code")).toBe("Current code");
  });

  it("refuses a wrong code the same way it refuses no code at all", () => {
    const mint = createTicketMint();

    // Nothing outstanding: the refusal must not be distinguishable from a bad
    // guess against a live ticket.
    expect(mint.redeem("not-a-real-code", "Phone")).toBeUndefined();

    mint.issue();
    expect(mint.redeem("not-a-real-code", "Phone")).toBeUndefined();
    // …and the live ticket survived the wrong guess, so a stranger guessing
    // cannot invalidate the code the person is actually looking at.
    expect(mint.outstanding()).toBeDefined();
  });

  it("mints codes that are not each other", () => {
    const mint = createTicketMint();
    const codes = new Set(Array.from({ length: 50 }, () => mint.issue().code));

    expect(codes.size).toBe(50);
    // Long enough that guessing inside a two-minute window is not a strategy.
    expect([...codes][0]!.length).toBeGreaterThanOrEqual(40);
  });
});

describe("a device label", () => {
  it("cannot forge a second row or hide behind padding", () => {
    expect(cleanLabel("  Jamie's phone  ")).toBe("Jamie's phone");
    // A newline in a name is how one row becomes two in anything that renders
    // a list as text.
    expect(cleanLabel("Jamie's phone\nThis machine")).toBe("Jamie's phone This machine");
  });

  it("falls back to the hub's own words rather than an empty row", () => {
    expect(cleanLabel("")).toBe(DEFAULT_DEVICE_LABEL);
    expect(cleanLabel("   \n  ")).toBe(DEFAULT_DEVICE_LABEL);
  });

  it("is bounded, because a device name is not a place to park a payload", () => {
    expect(cleanLabel("x".repeat(500))).toHaveLength(MAX_LABEL_LENGTH);
  });
});
