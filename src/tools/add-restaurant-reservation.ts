import { z } from "zod";
import type { AppContext } from "../context.js";
import { WanderlogError, WanderlogValidationError } from "../errors.js";
import type { Json0Op } from "../ot/apply.js";
import { resolvePlaceRef } from "../resolvers/place-ref.js";
import type { PlaceData, Section, TripPlan } from "../types.js";
import { isPlaceBlock } from "../types.js";
import {
  buildPlaceBlock,
  buildSectionObject,
  findHotelsSection,
  isValidDate,
  requireUserId,
  resolveEndpointPlace,
  submitOp,
  validateTimeInputs,
} from "./shared.js";

export const RESTAURANT_SECTION_HEADING = "Restaurant reservations";
const RESTAURANT_SECTION_META = { placeMarkerColor: "#17b978", placeMarkerIcon: "utensils" };

export const addRestaurantReservationInputSchema = {
  trip_key: z.string().min(1).describe("The trip to add the reservation to."),
  restaurant: z
    .string()
    .min(1)
    .describe(
      "Restaurant name (searched near the trip's destination) or a reference to a restaurant already in the trip.",
    ),
  date: z
    .string()
    .describe("Reservation date, YYYY-MM-DD."),
  time: z
    .string()
    .regex(/^\d{2}:\d{2}$/, "must be HH:mm")
    .optional()
    .describe("Reservation time, HH:mm (24h)."),
  party_size: z.number().int().min(1).optional().describe("Number of guests."),
  confirmation_number: z.string().optional().describe("Booking reference, if any."),
  notes: z
    .string()
    .optional()
    .describe("Extra details: name the booking is under, dress code, cancellation policy, seating request."),
};

export const addRestaurantReservationDescription = `
Records a restaurant reservation in the trip's "Restaurant reservations" section — the same
place Wanderlog files bookings added via Reservations → Restaurant. The restaurant is stored as
a place (so it shows on the map) with the reservation date/time and a note.

The section is created on first use. If the restaurant isn't in the trip yet it is looked up
near the destination. This does NOT make a booking with the restaurant — it records one the
user already has.
`.trim();

type Args = {
  trip_key: string;
  restaurant: string;
  date: string;
  time?: string;
  party_size?: number;
  confirmation_number?: string;
  notes?: string;
};

export function findRestaurantSection(trip: TripPlan): { index: number; section: Section } | null {
  const idx = trip.itinerary.sections.findIndex(
    (s) => s.mode !== "dayPlan" && s.heading.trim().toLowerCase() === RESTAURANT_SECTION_HEADING.toLowerCase(),
  );
  return idx >= 0 ? { index: idx, section: trip.itinerary.sections[idx]! } : null;
}

function longDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y!, m! - 1, d!));
  return dt.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
}

function to12h(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  const suffix = h! >= 12 ? "PM" : "AM";
  const hour = h! % 12 === 0 ? 12 : h! % 12;
  return `${hour}:${String(m).padStart(2, "0")} ${suffix}`;
}

export function buildReservationText(args: {
  date: string;
  time?: string;
  partySize?: number;
  confirmationNumber?: string;
  notes?: string;
}): { ops: Array<{ insert: string; attributes?: Record<string, unknown> }> } {
  const when = `${longDate(args.date)}${args.time ? ` at ${to12h(args.time)}` : ""}`;
  const ops: Array<{ insert: string; attributes?: Record<string, unknown> }> = [
    { insert: "Reservation at: ", attributes: { bold: true } },
    { insert: `${when}\n` },
  ];
  if (args.partySize) ops.push({ insert: `Party of ${args.partySize}\n` });
  if (args.confirmationNumber) {
    ops.push({ insert: "Confirmation: ", attributes: { bold: true } }, { insert: `${args.confirmationNumber}\n` });
  }
  if (args.notes?.trim()) ops.push({ insert: `${args.notes.trim()}\n` });
  return { ops };
}

export async function addRestaurantReservation(
  ctx: AppContext,
  args: Args,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const userId = requireUserId(ctx);
    if (!isValidDate(args.date)) {
      throw new WanderlogValidationError(`Invalid date: "${args.date}". Use YYYY-MM-DD.`);
    }
    validateTimeInputs(args.time, undefined);

    const entry = await ctx.tripCache.getEntry(args.trip_key);
    const trip = entry.snapshot;
    if (args.date < trip.startDate || args.date > trip.endDate) {
      throw new WanderlogValidationError(
        `${args.date} is outside the trip dates (${trip.startDate} → ${trip.endDate}).`,
      );
    }

    let place: PlaceData;
    const existing = resolvePlaceRef(trip, args.restaurant);
    if (existing.kind === "unique" && isPlaceBlock(existing.match.block)) {
      place = existing.match.block.place;
    } else {
      place = await resolveEndpointPlace(ctx, trip, entry.geos, args.restaurant);
    }
    const imageKeys = await ctx.rest.getPlacePhotos(place);

    const tripTitle = await submitOp(ctx, args.trip_key, async (locked, submit) => {
      const snapshot = locked.snapshot;
      const block = buildPlaceBlock(place, userId, { startTime: args.time }) as unknown as Record<string, unknown>;
      block.text = buildReservationText({
        date: args.date,
        time: args.time,
        partySize: args.party_size,
        confirmationNumber: args.confirmation_number,
        notes: args.notes,
      });
      if (imageKeys.length > 0) block.imageKeys = imageKeys;

      const found = findRestaurantSection(snapshot);
      const ops: Json0Op[] = [];
      if (found) {
        ops.push({
          p: ["itinerary", "sections", found.index, "blocks", found.section.blocks.length],
          li: block,
        });
      } else {
        // Wanderlog places reservation lists after the hotels list when one
        // exists, otherwise right after the top textOnly/Places sections.
        const hotels = findHotelsSection(snapshot);
        const firstDay = snapshot.itinerary.sections.findIndex((s) => s.mode === "dayPlan");
        const insertAt = hotels
          ? hotels.index + 1
          : firstDay >= 0
            ? firstDay
            : snapshot.itinerary.sections.length;
        const section = { ...buildSectionObject(RESTAURANT_SECTION_HEADING), ...RESTAURANT_SECTION_META, blocks: [block] };
        ops.push({ p: ["itinerary", "sections", insertAt], li: section });
      }
      await submit(ops);
      return snapshot.title;
    });

    const when = `${args.date}${args.time ? ` ${args.time}` : ""}`;
    const extra = [
      args.party_size ? `party of ${args.party_size}` : null,
      args.confirmation_number ? `conf. ${args.confirmation_number}` : null,
    ].filter(Boolean);
    return {
      content: [
        {
          type: "text",
          text: `Added reservation at ${place.name} on ${when}${extra.length ? ` (${extra.join(", ")})` : ""} to "${tripTitle}" → ${RESTAURANT_SECTION_HEADING}.`,
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
