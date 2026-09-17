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
};

export const updateTripDescription = `
Updates a trip's top-level settings: its title and/or its privacy level.

At least one of title or privacy must be provided. For date changes use
wanderlog_update_trip_dates; for day headings use wanderlog_rename_day.
`.trim();

type Args = {
  trip_key: string;
  title?: string;
  privacy?: Privacy;
};

export async function updateTrip(
  ctx: AppContext,
  args: Args,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const newTitle = args.title?.trim();
    if (!newTitle && !args.privacy) {
      throw new WanderlogValidationError("Provide at least one of title or privacy.");
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
