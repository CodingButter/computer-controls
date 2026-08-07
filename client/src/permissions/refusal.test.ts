import { expect, test } from "vitest";

import { deriveRefusal } from "./refusal.ts";
import { OPERATION_CLASSES } from "./registry.ts";

/** A desktop whose global classes reach `activate` — where the page can help. */
const INTERACTIVE = ["observe", "edit", "activate"];

test("an application at off, asked for activate, names the app, the class, the level and the switch", () => {
  const refusal = deriveRefusal({
    application: "Discord",
    demanded: "activate",
    access: "off",
    ceiling: INTERACTIVE,
    listed: true,
  });

  expect(refusal).toBeDefined();
  expect(refusal).toMatchObject({
    application: "Discord",
    demanded: "activate",
    access: "off",
    allowed: [],
    listed: true,
    remedy: {
      where: "permissions-page",
      application: "Discord",
      from: "off",
      to: "interact",
    },
  });
  expect(refusal!.sentence).toBe(
    '"Discord" is set to "off" on the permissions page, which does not permit activate-class actions. Open the permissions page and switch "Discord" from "off" to "interact".',
  );
});

test("an application at view, asked for an activate-class action, says what view holds and what to change", () => {
  const refusal = deriveRefusal({
    application: "Discord",
    demanded: "activate",
    access: "view",
    classes: ["observe"],
    ceiling: INTERACTIVE,
    listed: true,
  });

  expect(refusal).toMatchObject({
    demanded: "activate",
    access: "view",
    allowed: ["observe"],
    remedy: { where: "permissions-page", from: "view", to: "interact" },
  });
  expect(refusal!.sentence).toBe(
    '"Discord" is set to "view" on the permissions page, which does not permit activate-class actions. Open the permissions page and switch "Discord" from "view" to "interact".',
  );
});

test("a permitted action produces no refusal at all", () => {
  expect(
    deriveRefusal({
      application: "Discord",
      demanded: "observe",
      access: "view",
      classes: ["observe"],
      ceiling: INTERACTIVE,
      listed: true,
    }),
  ).toBeUndefined();

  // `interact` with no entry of its own holds exactly the ceiling.
  expect(
    deriveRefusal({
      application: "Discord",
      demanded: "submit",
      access: "interact",
      ceiling: [...OPERATION_CLASSES],
      listed: true,
    }),
  ).toBeUndefined();
});

test("a custom row says what it actually holds", () => {
  const refusal = deriveRefusal({
    application: "GIMP",
    demanded: "activate",
    access: "custom",
    classes: ["observe", "edit"],
    ceiling: INTERACTIVE,
    listed: true,
  });

  expect(refusal).toMatchObject({
    access: "custom",
    allowed: ["observe", "edit"],
    remedy: { where: "permissions-page", from: "custom", to: "interact" },
  });
  expect(refusal!.sentence).toContain('is set to "custom" on the permissions page');
});

test("a class the desktop withholds everywhere points at the config, never at a greyed-out switch", () => {
  // The default desktop: no `operationClasses`, so the ceiling is `observe`
  // and no permissions-page setting can grant `activate`.
  const refusal = deriveRefusal({
    application: "Discord",
    demanded: "activate",
    access: "off",
    ceiling: ["observe"],
    listed: true,
  });

  expect(refusal!.remedy).toEqual({
    where: "desktop-config",
    setting: "scopes.operationClasses",
    needs: "activate",
  });
  expect(refusal!.sentence).toBe(
    '"Discord" cannot be asked to do an activate-class action: this desktop\'s operation classes stop at "observe", which is set by scopes.operationClasses in the desktop config and not on the permissions page.',
  );
  // The sentence is spoken, so the article agrees with the class it names.
  expect(
    deriveRefusal({
      application: "Discord",
      demanded: "submit",
      access: "off",
      ceiling: ["observe"],
      listed: true,
    })!.sentence,
  ).toContain("cannot be asked to do a submit-class action");
  // It must not send anyone to a control that would not help.
  expect(refusal!.sentence).not.toContain("switch");
});

test("an application nothing answers to is refused as unlisted, not as denied", () => {
  const refusal = deriveRefusal({
    application: "Signal",
    demanded: "observe",
    access: "off",
    ceiling: INTERACTIVE,
    listed: false,
  });

  expect(refusal).toMatchObject({
    listed: false,
    allowed: [],
    remedy: { where: "permissions-page", from: "off", to: "view" },
  });
  expect(refusal!.sentence).toBe(
    '"Signal" is not listed on the permissions page, so nothing inside it is permitted. If it is installed, open the permissions page and switch it to "view".',
  );
});

test("every operation class gets a refusal naming itself, not just the launching one", () => {
  for (const demanded of OPERATION_CLASSES) {
    const refusal = deriveRefusal({
      application: "Discord",
      demanded,
      access: "off",
      ceiling: [...OPERATION_CLASSES],
      listed: true,
    });
    expect(refusal, demanded).toBeDefined();
    expect(refusal!.demanded).toBe(demanded);
    expect(refusal!.sentence).toContain(`${demanded}-class actions`);
  }
});

test("a refusal carries these fields and no others", () => {
  // The shape IS the leak control: a field carrying what the action would have
  // read or done inside the application fails here before it can be spoken.
  const refusal = deriveRefusal({
    application: "Discord",
    demanded: "activate",
    access: "off",
    ceiling: INTERACTIVE,
    listed: true,
  });

  expect(Object.keys(refusal!).sort()).toEqual([
    "access",
    "allowed",
    "application",
    "demanded",
    "listed",
    "remedy",
    "sentence",
  ]);
});
