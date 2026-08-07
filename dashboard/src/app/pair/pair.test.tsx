import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";

import { QrCode } from "@/components/devices/qr-code";
import { isLoopbackOrigin, pairingUrl } from "@/lib/hub";
import { deviceSubprotocol, readPairingCode } from "@/lib/pairing-store";

test("the code the QR carries never travels where a server can log it", () => {
  const url = pairingUrl("https://desk.example:4111", "abc-123_XYZ");

  // In the fragment, not the path or the query. Browsers do not send fragments
  // to servers, so the live credential stays out of access logs and out of the
  // Referer on whatever the paired page loads next.
  expect(url).toBe("https://desk.example:4111/pair#c=abc-123_XYZ");
  expect(url.split("#")[0]).not.toContain("abc-123_XYZ");
});

test("a code with URL punctuation in it survives the round trip", () => {
  // base64url avoids the worst of these, but a code that arrived mangled would
  // fail as "wrong code" and the ceremony would look broken rather than buggy.
  const code = "a+b/c=d&e#f";
  const url = pairingUrl("https://desk.example", code);

  expect(readPairingCode(new URL(url).hash)).toBe(code);
});

test("a fragment carrying more than the code still yields just the code", () => {
  // Scanners and chat apps append their own parameters. Slicing the fragment
  // would hand the tracking junk to the hub as part of the secret.
  expect(readPairingCode("#c=secret&utm_source=camera")).toBe("secret");
  expect(readPairingCode("#utm_source=camera&c=secret")).toBe("secret");
});

test("a link with no code in it is not a pairing link", () => {
  for (const hash of ["", "#", "#c=", "#other=secret", "#justtext"]) {
    expect(readPairingCode(hash), `${hash} is not a code`).toBeUndefined();
  }
});

test("an address only this machine can reach is recognised before the QR is trusted", () => {
  // A QR of localhost scans perfectly and then fails on the phone, which is the
  // most confusing way for pairing to go wrong.
  for (const origin of ["http://localhost:4111", "http://127.0.0.1:4111", "http://127.1.2.3"]) {
    expect(isLoopbackOrigin(origin), `${origin} is loopback`).toBe(true);
  }
  for (const origin of ["https://desk.example", "https://192.168.1.40:4111", "https://hub.local"]) {
    expect(isLoopbackOrigin(origin), `${origin} is reachable`).toBe(false);
  }
});

test("the QR renders the whole payload as a scannable symbol", () => {
  const value = pairingUrl("https://desk.example:4111", "x".repeat(43));
  const html = renderToStaticMarkup(<QrCode value={value} label="Pairing code." />);

  // A QR is square, has a quiet zone, and is dark-on-white — inverted by a dark
  // theme it does not scan at all, so the white ground is drawn explicitly.
  const viewBox = /viewBox="0 0 (\d+) (\d+)"/.exec(html);
  expect(viewBox).not.toBeNull();
  expect(viewBox![1]).toBe(viewBox![2]);
  expect(html).toContain('fill="#ffffff"');
  expect(html).toContain('fill="#000000"');

  // The symbol must be large enough to actually hold this payload: a version
  // too small to fit would have thrown, and a blank one would render no modules.
  const modules = (html.match(/fill="#000000"/g) ?? []).length;
  expect(modules).toBeGreaterThan(100);

  // The secret itself is never written into the markup as text — only as
  // geometry — so it cannot be lifted out of a copied DOM or a saved page.
  expect(html).not.toContain("xxxxx");
});

test("the credential is presented in exactly the spelling the events door parses", () => {
  const line = deviceSubprotocol({ id: "9f2c41ab", secret: "deadbeef", label: "My phone" });

  // The door splits on dots after a fixed prefix; any other spelling is refused
  // as a malformed offering and the phone never gets in.
  expect(line).toBe("comcon-device.9f2c41ab.deadbeef");
});
