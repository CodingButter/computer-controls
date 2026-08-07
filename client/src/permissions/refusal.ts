import { impliedClasses, type AppAccess, type OperationClass } from "./registry.ts";

/**
 * Why a permission refused, in the words the person who can fix it uses.
 *
 * A refusal that reaches the agent as a bare failure is a refusal the orb can
 * only relay as "I couldn't". The permission model already holds every fact the
 * sentence needs — which application, which class was asked for, what the page
 * currently says, and what the page would have to say instead — so this builder
 * assembles them rather than inventing a new vocabulary: `off` / `view` /
 * `interact` / `custom` are the page's own words, and the remedy names the
 * control the user actually has.
 *
 * The signature is the leak control. An element id, a window title, a
 * parameter or a result cannot reach this function, so no refusal it produces
 * can carry one: a denial says which door is shut, never what was behind it.
 *
 * It predicts; it does not enforce. The daemon's ceiling is the enforcement
 * point, which is why the arithmetic here is the mirrored `impliedClasses`
 * rather than a second opinion about the same file.
 */

export type PermissionRemedy =
  | {
      where: "permissions-page";
      application: string;
      from: AppAccess;
      to: "view" | "interact";
    }
  | { where: "desktop-config"; setting: "scopes.operationClasses"; needs: OperationClass };

export type PermissionRefusal = {
  /** The row's own display name, or the name asked for when nothing answers to it. */
  application: string;
  /** The class the refused action needed. */
  demanded: OperationClass;
  /** The level the permissions page currently shows for this application. */
  access: AppAccess;
  /** The classes actually in force; empty when the application is off or unlisted. */
  allowed: string[];
  /** False when no application on this desktop answers to that name. */
  listed: boolean;
  remedy: PermissionRemedy;
  /** The whole refusal in one line, for a voice surface to relay unchanged. */
  sentence: string;
};

export function deriveRefusal(params: {
  application: string;
  demanded: OperationClass;
  access: AppAccess;
  /** `PermissionRow.classes` — the row's own entry, when the file gives it one. */
  classes?: string[];
  /** `PermissionsView.ceiling`, already filled in up its ladder. */
  ceiling: string[];
  listed: boolean;
}): PermissionRefusal | undefined {
  const { application, demanded, access, classes, ceiling, listed } = params;

  // An application with no entry of its own holds exactly the ceiling — that
  // absence is what `deriveAccess` means when it returns `interact` with no
  // classes, and what the daemon reads as "the general answer stands".
  const allowed =
    access === "off" || !listed ? [] : classes ? impliedClasses(classes) : ceiling;

  // Permitted. Not a denial, so there is nothing to explain.
  if (allowed.includes(demanded)) return undefined;

  const shared = { application, demanded, access, allowed, listed };

  // The page cannot hand out a class the desktop's global classes withhold —
  // the dashboard greys the control out for exactly this reason — so sending
  // the user there would send them to a switch that changes nothing.
  if (!ceiling.includes(demanded)) {
    const highest = ceiling[ceiling.length - 1] ?? "observe";
    // The orb says this out loud, so the article has to agree with the class.
    const article = /^[aeiou]/.test(demanded) ? "an" : "a";
    return {
      ...shared,
      remedy: { where: "desktop-config", setting: "scopes.operationClasses", needs: demanded },
      sentence: `"${application}" cannot be asked to do ${article} ${demanded}-class action: this desktop's operation classes stop at "${highest}", which is set by scopes.operationClasses in the desktop config and not on the permissions page.`,
    };
  }

  const to = demanded === "observe" ? "view" : "interact";
  return {
    ...shared,
    remedy: { where: "permissions-page", application, from: access, to },
    sentence: listed
      ? `"${application}" is set to "${access}" on the permissions page, which does not permit ${demanded}-class actions. Open the permissions page and switch "${application}" from "${access}" to "${to}".`
      : `"${application}" is not listed on the permissions page, so nothing inside it is permitted. If it is installed, open the permissions page and switch it to "${to}".`,
  };
}
