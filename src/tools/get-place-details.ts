import { z } from "zod";
import type { AppContext } from "../context.js";
import { WanderlogError, WanderlogValidationError } from "../errors.js";
import { resolvePlaceRef } from "../resolvers/place-ref.js";
import type { PlaceData } from "../types.js";
import { isPlaceBlock } from "../types.js";
import { resolveEndpointPlace } from "./shared.js";

export const getPlaceDetailsInputSchema = {
  trip_key: z
    .string()
    .min(1)
    .describe(
      "Trip used as the geographic anchor for the lookup. If the place is already in this trip it is matched there first.",
    ),
  place: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Place name or natural-language reference (e.g. 'Sensō-ji', 'the hotel', 'Ichiran Ramen on day 2'). Either place or place_id is required.",
    ),
  place_id: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Exact Google place_id (starts with 'ChIJ…'), e.g. from wanderlog_search_places in detailed mode. Takes precedence over place.",
    ),
};

export const getPlaceDetailsDescription = `
Looks up rich details for a single place: address, rating and review count, phone, website,
weekly opening hours, business status, categories, coordinates, and a Google Maps link.

Use this to answer questions like "is X open on Monday?", "what's the phone number for Y?",
or to sanity-check a place before adding it. Resolution order:
  1. place_id if given (exact).
  2. A place already in the trip matching the reference (same syntax as wanderlog_remove_place).
  3. A place search biased to the trip's destination.
`.trim();

type Args = {
  trip_key: string;
  place?: string;
  place_id?: string;
};

export function formatPlaceDetails(p: PlaceData, source: string): string {
  const lines: string[] = [`${p.name}`];
  if (p.formatted_address) lines.push(`Address: ${p.formatted_address}`);
  if (p.rating !== undefined) {
    lines.push(`Rating: ★${p.rating} (${p.user_ratings_total ?? 0} reviews)`);
  }
  if (p.international_phone_number) lines.push(`Phone: ${p.international_phone_number}`);
  if (p.website) lines.push(`Website: ${p.website}`);
  if (p.business_status && p.business_status !== "OPERATIONAL") {
    lines.push(`Status: ${p.business_status}`);
  }
  const hours = p.opening_hours?.weekday_text;
  if (hours && hours.length > 0) {
    lines.push("Opening hours:");
    for (const h of hours) lines.push(`  ${h}`);
  }
  if (p.types && p.types.length > 0) {
    lines.push(`Categories: ${p.types.map((t) => t.replace(/_/g, " ")).join(", ")}`);
  }
  const amenities = p.amenities
    ? Object.entries(p.amenities)
        .filter(([, v]) => v)
        .map(([k]) => k.replace(/_/g, " "))
    : [];
  if (amenities.length > 0) lines.push(`Amenities: ${amenities.join(", ")}`);
  const loc = p.geometry?.location;
  if (loc) {
    lines.push(`Coordinates: ${loc.lat}, ${loc.lng}`);
    lines.push(
      `Google Maps: https://www.google.com/maps/search/?api=1&query=${loc.lat},${loc.lng}&query_place_id=${encodeURIComponent(p.place_id)}`,
    );
  }
  lines.push(`place_id: ${p.place_id}`);
  lines.push(`(${source})`);
  return lines.join("\n");
}

export async function getPlaceDetails(
  ctx: AppContext,
  args: Args,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    if (!args.place && !args.place_id) {
      throw new WanderlogValidationError("Provide either place or place_id.");
    }

    const entry = await ctx.tripCache.getEntry(args.trip_key);
    const trip = entry.snapshot;

    let detail: PlaceData;
    let source: string;
    if (args.place_id) {
      detail = await ctx.rest.getPlaceDetails(args.place_id);
      source = "looked up by place_id";
    } else {
      const resolved = resolvePlaceRef(trip, args.place!);
      if (resolved.kind === "ambiguous") {
        const lines = resolved.candidates.map((c, i) => {
          const name = isPlaceBlock(c.block) ? c.block.place.name : `block #${c.block.id}`;
          const loc = c.section.date ? `day ${c.section.date}` : c.section.heading || "unscheduled";
          return `  ${i + 1}. ${name} (${loc})`;
        });
        return {
          content: [
            {
              type: "text",
              text: `Multiple places in "${trip.title}" match "${args.place}":\n${lines.join("\n")}\n\nRetry with a more specific reference or an ordinal prefix (e.g. "1st ${args.place}").`,
            },
          ],
        };
      }
      if (resolved.kind === "unique" && isPlaceBlock(resolved.match.block)) {
        const inTrip = resolved.match.block.place;
        // Re-fetch so hours/rating are current rather than whatever was
        // frozen into the block when it was added.
        try {
          detail = await ctx.rest.getPlaceDetails(inTrip.place_id);
        } catch {
          detail = inTrip;
        }
        const where = resolved.match.section.date
          ? `day ${resolved.match.section.date}`
          : resolved.match.section.heading || "unscheduled";
        source = `in "${trip.title}", ${where}`;
      } else {
        detail = await resolveEndpointPlace(ctx, trip, entry.geos, args.place!);
        source = `search result near ${trip.title}; not in the trip`;
      }
    }

    return { content: [{ type: "text", text: formatPlaceDetails(detail, source) }] };
  } catch (err) {
    const msg =
      err instanceof WanderlogError
        ? err.toUserMessage()
        : `Unexpected error: ${(err as Error).message}`;
    return { content: [{ type: "text", text: msg }], isError: true };
  }
}
