import { z } from "zod";
import type { AppContext } from "../context.js";
import { WanderlogError, WanderlogValidationError } from "../errors.js";
import type { Json0Op } from "../ot/apply.js";
import { submitOp } from "./shared.js";

const PRIVACY_VALUES = ["private", "friends", "public"] as const;
type Privacy = (typeof PRIVACY_VALUES)[number];

export const updateTripInputSchema = {
  trip_key: z.string().min(1).describe("The trip to update."),
  title: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe("New trip title, e.g. 'Japan Golden Route — Spring 2027'."),
  privacy: z
    .enum(PRIVACY_VALUES)
    .optional()
    .describe(
      "Who can see the trip: 'private' (only you and invited collaborators), 'friends' (people you follow on Wanderlog), or 'public' (anyone with the link; may appear in Wanderlog's guide listings).",
    ),
  default_travel_mode: z
    .enum(["driving", "transit"])
    .optional()
    .describe(
      "Default transportation used for the travel times shown between places: 'driving' (drive + walk short distances) or 'transit' (public transit + walk short distances).",
    ),
};

export const updateTripDescription = `
Updates a trip's top-level settings: title, privacy level, and/or default travel mode — the
same fields as Wanderlog's "Trip settings" dialog.

At least one field must be provided. For date changes use
wanderlog_update_trip_dates; for day headings use wanderlog_rename_day.
`.trim();

type Args = {
  trip_key: string;
  title?: string;
  privacy?: Privacy;
  default_travel_mode?: "driving" | "transit";
};

export async function updateTrip(
  ctx: AppContext,
  args: Args,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const newTitle = args.title?.trim();
    if (!newTitle && !args.privacy && !args.default_travel_mode) {
      throw new WanderlogValidationError("Provide at least one of title, privacy, or default_travel_mode.");
    }

    const result = await submitOp(ctx, args.trip_key, async (entry, submit) => {
      const trip = entry.snapshot;
      const changes: string[] = [];
      const ops: Json0Op[] = [];

      if (newTitle && newTitle !== trip.title) {
        ops.push({ p: ["title"], od: trip.title, oi: newTitle });
        changes.push(`title: "${trip.title}" → "${newTitle}"`);
      }
      if (args.privacy && args.privacy !== trip.privacy) {
        ops.push({ p: ["privacy"], od: trip.privacy, oi: args.privacy });
        changes.push(`privacy: ${trip.privacy} → ${args.privacy}`);
      }

      if (args.default_travel_mode) {
        const options = trip.itinerary.options;
        const current = options?.defaultTravelMode ?? "driving";
        if (current !== args.default_travel_mode) {
          const next = { ...(options ?? {}), defaultTravelMode: args.default_travel_mode };
          const op: Json0Op = { p: ["itinerary", "options"], oi: next };
          if (options !== undefined) op.od = options;
          ops.push(op);
          changes.push(`default travel mode: ${current} → ${args.default_travel_mode}`);
        }
      }

      if (ops.length === 0) {
        return { unchanged: true as const, title: trip.title, privacy: trip.privacy };
      }
      await submit(ops);
      return { unchanged: false as const, changes, title: newTitle ?? trip.title };
    });

    if (result.unchanged) {
      return {
        content: [
          {
            type: "text",
            text: `"${result.title}" already has the requested settings (privacy: ${result.privacy}) — no change made.`,
          },
        ],
      };
    }
    return {
      content: [
        { type: "text", text: `Updated "${result.title}": ${result.changes.join("; ")}.` },
      ],
    };
  } catch (err) {
    const msg =
      err instanceof WanderlogError
        ? err.toUserMessage()
        : `Unexpected error: ${(err as Error).message}`;
    return { content: [{ type: "text", text: msg }], isError: true };
  }
}
