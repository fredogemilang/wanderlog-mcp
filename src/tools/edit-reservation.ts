import { z } from "zod";
import type { AppContext } from "../context.js";
import { WanderlogError, WanderlogValidationError } from "../errors.js";
import type { Json0Op } from "../ot/apply.js";
import {
  describeReservation,
  resolveReservationRef,
  type ReservationKind,
} from "../resolvers/reservation-ref.js";
import type { Block } from "../types.js";
import { assertBlockAtPath, isValidDate, submitOp, validateTimeInputs } from "./shared.js";

const TIME = /^\d{2}:\d{2}$/;

export const editReservationInputSchema = {
  trip_key: z.string().min(1).describe("The trip containing the reservation."),
  reservation: z
    .string()
    .min(1)
    .describe(
      "Which reservation to edit: 'the flight', 'the hotel', 'the train', 'JL 123', 'Hilton Tokyo', 'Shinkansen to Kyoto', 'the ferry on day 3', '2nd flight'. Matches airline/carrier, flight number, endpoints, hotel name, and confirmation numbers.",
    ),
  confirmation_number: z
    .string()
    .optional()
    .describe("Booking/confirmation reference. Pass '' to clear."),
  traveler_names: z
    .array(z.string().min(1))
    .optional()
    .describe("Replace the list of traveler names on the booking."),
  notes: z.string().optional().describe("Replace the reservation's notes text. Pass '' to clear."),
  carrier: z
    .string()
    .optional()
    .describe(
      "Airline (name or 2-letter IATA code) for flights, or operator name for ferry/bus/train.",
    ),
  flight_number: z
    .union([z.string(), z.number()])
    .optional()
    .describe("Flight number without the airline prefix (flights only)."),
  start_date: z
    .string()
    .optional()
    .describe(
      "YYYY-MM-DD. Departure date (flight/ferry/bus/train), pick-up date (rental car), or check-in date (hotel).",
    ),
  start_time: z
    .string()
    .optional()
    .describe("HH:mm. Departure time or pick-up time. Not used for hotels."),
  end_date: z
    .string()
    .optional()
    .describe(
      "YYYY-MM-DD. Arrival date (flight/ferry/bus/train), drop-off date (rental car), or check-out date (hotel).",
    ),
  end_time: z
    .string()
    .optional()
    .describe("HH:mm. Arrival time or drop-off time. Not used for hotels."),
};

export const editReservationDescription = `
Edits fields on an existing reservation block — flight, ferry/bus/train, rental car, or hotel
stay — without removing and re-adding it. Only the fields you pass are changed.

Field mapping by reservation type:
  - flight:        carrier=airline, flight_number, start_*=departure, end_*=arrival
  - ferry/bus/train: carrier=operator, start_*=departure, end_*=arrival
  - rental car:    start_*=pick-up, end_*=drop-off
  - hotel:         start_date=check-in, end_date=check-out (times ignored)
confirmation_number, traveler_names, and notes apply to every type.

To change the places/airports themselves, remove the block (wanderlog_remove_place) and add
it again with the appropriate add_* tool. For plain places use wanderlog_annotate_place.
`.trim();

type Args = {
  trip_key: string;
  reservation: string;
  confirmation_number?: string;
  traveler_names?: string[];
  notes?: string;
  carrier?: string;
  flight_number?: string | number;
  start_date?: string;
  start_time?: string;
  end_date?: string;
  end_time?: string;
};

type Rec = Record<string, unknown>;

function setOp(path: (string | number)[], record: Rec | undefined, key: string, value: unknown): Json0Op {
  const op: Json0Op = { p: [...path, key], oi: value };
  if (record && key in record) op.od = record[key];
  return op;
}

function endpointKeys(kind: ReservationKind): { start: string; end: string } {
  if (kind === "rentalCar") return { start: "pickUp", end: "dropOff" };
  return { start: "depart", end: "arrive" };
}

function endpointLabels(kind: ReservationKind): { start: string; end: string } {
  if (kind === "rentalCar") return { start: "pick-up", end: "drop-off" };
  if (kind === "hotel") return { start: "check-in", end: "check-out" };
  return { start: "departure", end: "arrival" };
}

export async function editReservation(
  ctx: AppContext,
  args: Args,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const editableKeys: Array<keyof Args> = [
      "confirmation_number",
      "traveler_names",
      "notes",
      "carrier",
      "flight_number",
      "start_date",
      "start_time",
      "end_date",
      "end_time",
    ];
    if (!editableKeys.some((k) => args[k] !== undefined)) {
      throw new WanderlogValidationError("Provide at least one field to change.");
    }
    for (const [label, d] of [["start_date", args.start_date], ["end_date", args.end_date]] as const) {
      if (d !== undefined && !isValidDate(d)) {
        throw new WanderlogValidationError(`Invalid ${label}: "${d}". Use YYYY-MM-DD.`);
      }
    }
    for (const [label, t] of [["start_time", args.start_time], ["end_time", args.end_time]] as const) {
      if (t !== undefined && !TIME.test(t)) {
        throw new WanderlogValidationError(`Invalid ${label}: "${t}". Use HH:mm.`);
      }
    }
    validateTimeInputs(args.start_time, undefined);
    validateTimeInputs(args.end_time, undefined);

    const result = await submitOp(ctx, args.trip_key, async (entry, submit) => {
      const trip = entry.snapshot;
      const resolved = resolveReservationRef(trip, args.reservation);
      if (resolved.kind === "none") {
        throw new WanderlogError(
          `No reservation matching "${args.reservation}" found in "${trip.title}"`,
          "reservation_not_found",
          {
            hint: "Reservations are flights, ferries/buses/trains, rental cars, and hotel stays. For a plain place use wanderlog_annotate_place.",
            followUps: [
              `Call wanderlog_get_trip with trip_key "${args.trip_key}" and response_format "detailed" to see reservations.`,
            ],
          },
        );
      }
      if (resolved.kind === "ambiguous") {
        const lines = resolved.candidates.map(
          (c, i) => `  ${i + 1}. ${describeReservation(c.block)} (${c.kind})`,
        );
        return {
          response: {
            content: [
              {
                type: "text" as const,
                text: `Several reservations match "${args.reservation}":\n${lines.join("\n")}\n\nRetry with a more specific reference or an ordinal prefix (e.g. "2nd flight").`,
              },
            ],
          },
        };
      }

      const { sectionIndex, blockIndex, kind } = resolved.match;
      const block = assertBlockAtPath(trip, sectionIndex, blockIndex, resolved.match.block.id) as Block & Rec;
      // Effective values after this call's edits, kept separate from the cache
      // snapshot so `od` stays the true prior value and the snapshot is only
      // touched by applyLocalOp after a successful submit.
      const working: Rec = { ...block };
      const base = ["itinerary", "sections", sectionIndex, "blocks", blockIndex];
      const ops: Json0Op[] = [];
      const changes: string[] = [];
      const labels = endpointLabels(kind);

      if (kind === "hotel") {
        if (args.start_time !== undefined || args.end_time !== undefined) {
          throw new WanderlogValidationError(
            "Hotel stays only have check-in/check-out dates; start_time and end_time are not applicable.",
          );
        }
        if (args.carrier !== undefined || args.flight_number !== undefined) {
          throw new WanderlogValidationError("carrier and flight_number are not applicable to hotels.");
        }
        const hotel = (block.hotel ?? {}) as Rec;
        const next = { ...hotel } as Rec;
        if (args.start_date !== undefined) { next.checkIn = args.start_date; changes.push(`check-in → ${args.start_date}`); }
        if (args.end_date !== undefined) { next.checkOut = args.end_date; changes.push(`check-out → ${args.end_date}`); }
        if (args.confirmation_number !== undefined) {
          next.confirmationNumber = args.confirmation_number || null;
          changes.push(`confirmation → ${args.confirmation_number || "(cleared)"}`);
        }
        if (args.traveler_names !== undefined) {
          next.travelerNames = args.traveler_names;
          changes.push(`travelers → ${args.traveler_names.join(", ") || "(none)"}`);
        }
        const checkIn = next.checkIn as string | null | undefined;
        const checkOut = next.checkOut as string | null | undefined;
        if (checkIn && checkOut && checkOut < checkIn) {
          throw new WanderlogValidationError(
            `check-out (${checkOut}) must be on or after check-in (${checkIn}).`,
          );
        }
        if (changes.length > 0) ops.push(setOp(base, block, "hotel", next));
      } else {
        if (args.carrier !== undefined) {
          if (kind === "flight") {
            const trimmed = args.carrier.trim();
            const airline = /^[A-Za-z0-9]{2}$/.test(trimmed)
              ? { iata: trimmed.toUpperCase() }
              : { name: trimmed };
            const flightInfo = { ...((working.flightInfo as Rec) ?? {}), airline };
            ops.push(setOp(base, block, "flightInfo", flightInfo));
            working.flightInfo = flightInfo;
            changes.push(`airline → ${trimmed}`);
          } else {
            ops.push(setOp(base, block, "carrier", args.carrier));
            changes.push(`carrier → ${args.carrier}`);
          }
        }
        if (args.flight_number !== undefined) {
          if (kind !== "flight") {
            throw new WanderlogValidationError("flight_number only applies to flights.");
          }
          const number = typeof args.flight_number === "string" && /^\d+$/.test(args.flight_number)
            ? Number(args.flight_number)
            : args.flight_number;
          const flightInfo = { ...((working.flightInfo as Rec) ?? {}), number };
          // Replace the whole sub-object so airline+number edits in one call
          // don't produce two ops fighting over the same path.
          const prior = ops.findIndex((o) => o.p[o.p.length - 1] === "flightInfo");
          if (prior >= 0) ops.splice(prior, 1);
          ops.push(setOp(base, block, "flightInfo", flightInfo));
          changes.push(`flight number → ${number}`);
        }

        const keys = endpointKeys(kind);
        const patchEndpoint = (
          key: string,
          label: string,
          date: string | undefined,
          time: string | undefined,
        ) => {
          if (date === undefined && time === undefined) return;
          const current = (working[key] as Rec | undefined) ?? {};
          const next = { ...current } as Rec;
          if (date !== undefined) next.date = date;
          if (time !== undefined) next.time = time;
          ops.push(setOp(base, block, key, next));
          changes.push(`${label} → ${[next.date, next.time].filter(Boolean).join(" ")}`);
          working[key] = next;
        };
        patchEndpoint(keys.start, labels.start, args.start_date, args.start_time);
        patchEndpoint(keys.end, labels.end, args.end_date, args.end_time);

        const start = working[keys.start] as Rec | undefined;
        const end = working[keys.end] as Rec | undefined;
        if (start?.date && end?.date) {
          const s = `${start.date}T${start.time ?? "00:00"}`;
          const e = `${end.date}T${end.time ?? "00:00"}`;
          if (e < s) {
            throw new WanderlogValidationError(
              `${labels.end} (${end.date} ${end.time ?? ""}) must be on or after ${labels.start} (${start.date} ${start.time ?? ""}).`,
            );
          }
        }

        if (args.confirmation_number !== undefined) {
          if (args.confirmation_number === "" && "confirmationNumber" in block) {
            ops.push({ p: [...base, "confirmationNumber"], od: block.confirmationNumber });
          } else if (args.confirmation_number !== "") {
            ops.push(setOp(base, block, "confirmationNumber", args.confirmation_number));
          }
          changes.push(`confirmation → ${args.confirmation_number || "(cleared)"}`);
        }
        if (args.traveler_names !== undefined) {
          ops.push(setOp(base, block, "travelerNames", args.traveler_names));
          changes.push(`travelers → ${args.traveler_names.join(", ") || "(none)"}`);
        }
      }

      if (args.notes !== undefined) {
        const next = { ops: [{ insert: args.notes ? `${args.notes}\n` : "\n" }] };
        ops.push(setOp(base, block, "text", next));
        changes.push(args.notes ? `notes updated` : "notes cleared");
      }

      const label = describeReservation(resolved.match.block);
      if (ops.length === 0) {
        return { label, kind, changes: [], tripTitle: trip.title };
      }
      await submit(ops);
      return { label, kind, changes, tripTitle: trip.title };
    });
    if ("response" in result && result.response) return result.response;

    const text = result.changes.length === 0
      ? `${result.label} already matched the request — no change made.`
      : `Updated ${result.kind === "rentalCar" ? "rental car" : result.kind} "${result.label}" in "${result.tripTitle}": ${result.changes.join("; ")}.`;
    return { content: [{ type: "text", text }] };
  } catch (err) {
    const msg =
      err instanceof WanderlogError
        ? err.toUserMessage()
        : `Unexpected error: ${(err as Error).message}`;
    return { content: [{ type: "text", text: msg }], isError: true };
  }
}
