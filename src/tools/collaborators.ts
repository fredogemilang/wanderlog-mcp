import { z } from "zod";
import type { AppContext } from "../context.js";
import { WanderlogError, WanderlogValidationError } from "../errors.js";
import type { Contributor, Invitee, TripPlan } from "../types.js";

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

function fail(err: unknown): ToolResult {
  const msg =
    err instanceof WanderlogError
      ? err.toUserMessage()
      : `Unexpected error: ${(err as Error).message}`;
  return { content: [{ type: "text", text: msg }], isError: true };
}

export function collaboratorsOf(trip: TripPlan): Contributor[] {
  const byId = new Map<number, Contributor>();
  for (const c of [...(trip.contributors ?? []), ...(trip.editors ?? [])]) {
    if (!byId.has(c.id)) byId.set(c.id, c);
  }
  return [...byId.values()];
}

function labelOf(c: Contributor): string {
  return c.name ? `${c.name} (@${c.username})` : `@${c.username}`;
}

/**
 * Match a free-form reference ("Ali", "@ali1253", "ali@example.com") against
 * the trip's collaborators by username, display name, or exact id.
 */
export function findCollaborator(
  trip: TripPlan,
  ref: string,
): { kind: "unique"; user: Contributor } | { kind: "ambiguous"; users: Contributor[] } | { kind: "none" } {
  const q = ref.trim().replace(/^@/, "").toLowerCase();
  if (!q) return { kind: "none" };
  const all = collaboratorsOf(trip);
  const exact = all.filter(
    (c) => c.username.toLowerCase() === q || (c.name ?? "").toLowerCase() === q || String(c.id) === q,
  );
  if (exact.length === 1) return { kind: "unique", user: exact[0]! };
  if (exact.length > 1) return { kind: "ambiguous", users: exact };
  const partial = all.filter(
    (c) => c.username.toLowerCase().includes(q) || (c.name ?? "").toLowerCase().includes(q),
  );
  if (partial.length === 1) return { kind: "unique", user: partial[0]! };
  if (partial.length > 1) return { kind: "ambiguous", users: partial };
  return { kind: "none" };
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

export const listCollaboratorsInputSchema = {
  trip_key: z.string().min(1).describe("The trip whose tripmates to list."),
};

export const listCollaboratorsDescription = `
Lists the people on a trip: the owner and every collaborator ("tripmate") who can edit it,
plus any pending invitations. Use before wanderlog_remove_collaborator, or when assigning
expenses to people with wanderlog_add_expense (paid_by / split_with).
`.trim();

export async function listCollaborators(
  ctx: AppContext,
  args: { trip_key: string },
): Promise<ToolResult> {
  try {
    const entry = await ctx.tripCache.getEntry(args.trip_key);
    const trip = entry.snapshot;
    const people = collaboratorsOf(trip);
    const lines = people.map((c) => {
      const tags: string[] = [];
      if (c.id === trip.userId) tags.push("owner");
      if (ctx.userId && c.id === ctx.userId) tags.push("you");
      return `  • ${labelOf(c)}${tags.length ? ` — ${tags.join(", ")}` : ""}`;
    });
    let pending = "";
    try {
      const invites = await ctx.rest.listInvites(args.trip_key);
      if (invites.length > 0) {
        const names = invites.map((i) => {
          const r = i as Record<string, unknown>;
          return String(r.email ?? r.username ?? r.name ?? JSON.stringify(i));
        });
        pending = `\n\nPending invitations (${invites.length}):\n${names.map((n) => `  • ${n}`).join("\n")}`;
      }
    } catch {
      // Invites are a nice-to-have; the collaborator list is the answer.
    }
    return {
      content: [
        { type: "text", text: `Tripmates on "${trip.title}" (${people.length}):\n${lines.join("\n")}${pending}` },
      ],
    };
  } catch (err) {
    return fail(err);
  }
}

// ---------------------------------------------------------------------------
// invite
// ---------------------------------------------------------------------------

export const inviteCollaboratorInputSchema = {
  trip_key: z.string().min(1).describe("The trip to invite people to."),
  emails: z
    .array(z.string().email())
    .optional()
    .describe("Email addresses to invite. Each receives an invitation email from Wanderlog."),
  usernames: z
    .array(z.string().min(1))
    .optional()
    .describe("Wanderlog usernames to invite (with or without '@'). Looked up via Wanderlog user search."),
  message: z
    .string()
    .max(1000)
    .optional()
    .describe("Optional personal note included in the invitation."),
};

export const inviteCollaboratorDescription = `
Invites people to collaborate on a trip (they become "tripmates" who can edit it). Accepts
email addresses and/or Wanderlog usernames. Wanderlog sends the invitation emails.

This contacts real people — only call it when the user has explicitly asked to invite them
and confirmed the addresses/usernames.
`.trim();

type InviteArgs = {
  trip_key: string;
  emails?: string[];
  usernames?: string[];
  message?: string;
};

export async function inviteCollaborator(ctx: AppContext, args: InviteArgs): Promise<ToolResult> {
  try {
    const emails = [...new Set((args.emails ?? []).map((e) => e.trim().toLowerCase()))].filter(Boolean);
    const usernames = [...new Set((args.usernames ?? []).map((u) => u.trim().replace(/^@/, "")))].filter(Boolean);
    if (emails.length === 0 && usernames.length === 0) {
      throw new WanderlogValidationError("Provide at least one email or username to invite.");
    }

    const entry = await ctx.tripCache.getEntry(args.trip_key);
    const trip = entry.snapshot;
    const existing = collaboratorsOf(trip);

    const invitees: Invitee[] = emails.map((email) => ({ type: "email", email }));
    const already: string[] = [];
    const notFound: string[] = [];
    for (const username of usernames) {
      const hit = existing.find((c) => c.username.toLowerCase() === username.toLowerCase());
      if (hit) {
        already.push(labelOf(hit));
        continue;
      }
      const matches = await ctx.rest.userAutocomplete(username);
      const user = matches.find((m) => m.username.toLowerCase() === username.toLowerCase());
      if (!user) {
        notFound.push(username);
        continue;
      }
      invitees.push({
        type: "user",
        id: user.id,
        username: user.username,
        name: user.name,
        profilePictureKey: user.profilePictureKey ?? null,
      });
    }

    if (notFound.length > 0) {
      throw new WanderlogError(
        `No Wanderlog user found with username: ${notFound.join(", ")}`,
        "user_not_found",
        "Check the spelling, or invite by email address instead.",
      );
    }
    if (invitees.length === 0) {
      return {
        content: [
          { type: "text", text: `Everyone listed is already on "${trip.title}": ${already.join(", ")}. No invitations sent.` },
        ],
      };
    }

    await ctx.rest.inviteToTrip(args.trip_key, invitees, args.message ?? "");
    ctx.tripCache.invalidate(args.trip_key);

    const sent = invitees.map((i) => (i.type === "email" ? i.email : `@${i.username}`));
    const parts = [`Invited ${sent.join(", ")} to "${trip.title}".`];
    if (already.length > 0) parts.push(`Already tripmates: ${already.join(", ")}.`);
    return { content: [{ type: "text", text: parts.join(" ") }] };
  } catch (err) {
    return fail(err);
  }
}

// ---------------------------------------------------------------------------
// remove
// ---------------------------------------------------------------------------

export const removeCollaboratorInputSchema = {
  trip_key: z.string().min(1).describe("The trip to remove the tripmate from."),
  user: z
    .string()
    .min(1)
    .describe("Who to remove — display name or username (with or without '@') as shown by wanderlog_list_collaborators."),
};

export const removeCollaboratorDescription = `
Removes a collaborator ("tripmate") from a trip so they can no longer edit it. The trip owner
cannot be removed. Resolve the person with wanderlog_list_collaborators first if unsure.
`.trim();

export async function removeCollaborator(
  ctx: AppContext,
  args: { trip_key: string; user: string },
): Promise<ToolResult> {
  try {
    const entry = await ctx.tripCache.getEntry(args.trip_key);
    const trip = entry.snapshot;
    const found = findCollaborator(trip, args.user);
    if (found.kind === "none") {
      throw new WanderlogError(
        `No tripmate matching "${args.user}" on "${trip.title}"`,
        "collaborator_not_found",
        { followUps: [`Call wanderlog_list_collaborators with trip_key "${args.trip_key}".`] },
      );
    }
    if (found.kind === "ambiguous") {
      const lines = found.users.map((u) => `  • ${labelOf(u)}`);
      return {
        content: [
          { type: "text", text: `Several tripmates match "${args.user}":\n${lines.join("\n")}\n\nRetry with the exact username.` },
        ],
      };
    }
    if (found.user.id === trip.userId) {
      throw new WanderlogValidationError(
        `${labelOf(found.user)} owns "${trip.title}" and cannot be removed.`,
      );
    }
    await ctx.rest.removeCollaborator(args.trip_key, found.user.id);
    ctx.tripCache.invalidate(args.trip_key);
    return {
      content: [{ type: "text", text: `Removed ${labelOf(found.user)} from "${trip.title}".` }],
    };
  } catch (err) {
    return fail(err);
  }
}
