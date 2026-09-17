import { z } from "zod";
import type { AppContext } from "../context.js";
import { WanderlogError, WanderlogValidationError } from "../errors.js";

export const deleteTripInputSchema = {
  trip_key: z.string().min(1).describe("The trip to delete permanently."),
  confirm_title: z
    .string()
    .min(1)
    .describe(
      "The trip's exact current title, as shown by wanderlog_list_trips or wanderlog_get_trip. Acts as a safety check — deletion is refused if it doesn't match.",
    ),
};

export const deleteTripDescription = `
Permanently deletes a Wanderlog trip — itinerary, notes, reservations, budget, and journal.
This cannot be undone.

Safety: you must pass the trip's exact title in confirm_title. Look it up first with
wanderlog_get_trip (or wanderlog_list_trips) and only call this tool after the user has
explicitly confirmed they want the trip deleted.
`.trim();

type Args = {
  trip_key: string;
  confirm_title: string;
};

function normalizeTitle(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

export async function deleteTrip(
  ctx: AppContext,
  args: Args,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const trip = await ctx.rest.getTrip(args.trip_key);
    if (normalizeTitle(trip.title) !== normalizeTitle(args.confirm_title)) {
      throw new WanderlogValidationError(
        `confirm_title "${args.confirm_title}" does not match the trip's title "${trip.title}" — nothing was deleted.`,
        "Re-check the trip with wanderlog_get_trip and pass its exact title.",
      );
    }

    await ctx.rest.deleteTrip(args.trip_key);
    // The trip no longer exists server-side; drop any cached snapshot and
    // live subscription so later calls fail fast instead of hitting a ghost.
    ctx.tripCache.invalidate(args.trip_key);
    ctx.pool.evict(args.trip_key);

    return {
      content: [
        {
          type: "text",
          text: `Deleted trip "${trip.title}" (${trip.startDate} → ${trip.endDate}, ${trip.placeCount} places). This cannot be undone.`,
        },
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
