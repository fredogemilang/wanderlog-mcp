import { z } from "zod";
import type { AppContext } from "../context.js";
import { WanderlogError } from "../errors.js";
import {
  buildAirportEndpoint,
  buildFlightBlock,
  requireUserId,
  resolveEndpointPlace,
  sectionInsertOp,
  submitOp,
  validateChronology,
} from "./shared.js";

export const addFlightInputSchema = {
  trip_key: z.string().min(1).describe("The trip to add the flight booking to."),
  airline: z
    .string()
    .min(1)
    .describe("Airline name or IATA code, e.g. 'China Eastern Airlines' or 'MU'."),
  flight_number: z
    .union([z.string().min(1), z.number()])
    .describe("Flight number, e.g. '5070' or 'MU5070'."),
  from_airport: z
    .string()
    .min(1)
    .describe(
      "Departure airport code or name, e.g. 'CGK' or 'Soekarno-Hatta International Airport'.",
    ),
  to_airport: z
    .string()
    .min(1)
    .describe(
      "Arrival airport code or name, e.g. 'PVG' or 'Shanghai Pudong International Airport'.",
    ),
  depart_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD")
    .describe("Departure date."),
  depart_time: z
    .string()
    .regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, "must be HH:mm (00:00–23:59)")
    .describe("Departure time (24h)."),
  arrive_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD")
    .describe("Arrival date."),
  arrive_time: z
    .string()
    .regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, "must be HH:mm (00:00–23:59)")
    .describe("Arrival time (24h)."),
  confirmation_number: z
    .string()
    .optional()
    .describe("Booking/confirmation number (optional)."),
  notes: z.string().optional().describe("Free-text notes shown on the block (optional)."),
  traveler_names: z
    .array(z.string().min(1))
    .optional()
    .describe("Passenger or traveler names (optional)."),
};

export const addFlightDescription = `
Adds a flight booking to a Wanderlog trip. Departure and arrival airports are matched
against Google Places near the trip's destination. Flights are added to the trip's
"Flights" section, which is created automatically if absent.

Returns confirmation with the resolved flight route and departure time.
`.trim();

type Args = {
  trip_key: string;
  airline: string;
  flight_number: string | number;
  from_airport: string;
  to_airport: string;
  depart_date: string;
  depart_time: string;
  arrive_date: string;
  arrive_time: string;
  confirmation_number?: string;
  notes?: string;
  traveler_names?: string[];
};

export async function addFlight(
  ctx: AppContext,
  args: Args,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    validateChronology(
      "depart",
      args.depart_date,
      args.depart_time,
      "arrive",
      args.arrive_date,
      args.arrive_time,
    );

    const userId = requireUserId(ctx);
    const entry = await ctx.tripCache.getEntry(args.trip_key);
    const [fromPlace, toPlace] = await Promise.all([
      resolveEndpointPlace(ctx, entry.snapshot, entry.geos, args.from_airport),
      resolveEndpointPlace(ctx, entry.snapshot, entry.geos, args.to_airport),
    ]);

    const depart = buildAirportEndpoint(
      args.from_airport,
      fromPlace,
      args.depart_date,
      args.depart_time,
    );
    const arrive = buildAirportEndpoint(
      args.to_airport,
      toPlace,
      args.arrive_date,
      args.arrive_time,
    );

    const tripTitle = await submitOp(ctx, args.trip_key, async (lockedEntry, submit) => {
      const block = buildFlightBlock(userId, {
        airline: args.airline,
        flight_number: args.flight_number,
        depart,
        arrive,
        confirmation_number: args.confirmation_number,
        notes: args.notes,
        traveler_names: args.traveler_names,
      });
      await submit([sectionInsertOp(lockedEntry.snapshot, "flights", block)]);
      return lockedEntry.snapshot.title;
    });

    const flightNumStr = String(args.flight_number).trim();
    const flightLabel = flightNumStr.toUpperCase().startsWith(args.airline.trim().toUpperCase())
      ? flightNumStr
      : `${args.airline.trim()} ${flightNumStr}`;

    const text = `Added flight ${flightLabel} to "${tripTitle}" · ${fromPlace.name} → ${toPlace.name} · ${args.depart_date} ${args.depart_time}.`;
    return { content: [{ type: "text", text }] };
  } catch (err) {
    const msg =
      err instanceof WanderlogError
        ? err.toUserMessage()
        : `Unexpected error: ${(err as Error).message}`;
    return { content: [{ type: "text", text: msg }], isError: true };
  }
}
