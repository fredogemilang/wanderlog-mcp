import { z } from "zod";
import type { AppContext } from "../context.js";
import { WanderlogError, WanderlogValidationError } from "../errors.js";
import { resolveDay } from "../resolvers/day.js";
import type { DistanceLeg, PlaceBlock, Section, TripPlan } from "../types.js";
import { isPlaceBlock } from "../types.js";
import { findDaySectionByDate, resolveSectionRef } from "./shared.js";

const TRAVEL_MODES = ["driving", "transit", "walking"] as const;
export type TravelMode = (typeof TRAVEL_MODES)[number];

export const getTravelTimesInputSchema = {
  trip_key: z.string().min(1).describe("The trip to analyse."),
  day: z
    .string()
    .optional()
    .describe(
      "Which day (or list) to compute legs for: 'day 2', 'May 4', '2026-05-04', or a custom list heading. Omit to cover every day that has 2+ places.",
    ),
  travel_mode: z
    .enum(TRAVEL_MODES)
    .optional()
    .describe(
      "'driving', 'transit' (public transport), or 'walking'. Defaults to the trip's default travel mode (driving unless changed).",
    ),
};

export const getTravelTimesDescription = `
Computes travel distance and time between consecutive places in a day, in the order they are
currently arranged — the same numbers Wanderlog shows between itinerary items.

Use it to sanity-check a day ("is day 2 too spread out?"), to answer "how long from X to Y?",
or to decide a better order before calling wanderlog_reorder_places. Legs are returned per
day with a total; places without coordinates are skipped.
`.trim();

type Args = {
  trip_key: string;
  day?: string;
  travel_mode?: TravelMode;
};

type Leg = {
  from: string;
  to: string;
  distanceText: string;
  durationText: string;
  distanceM: number;
  durationS: number;
};

export function legKey(from: string, to: string, mode: string): string {
  return JSON.stringify([from, to, mode]);
}

function sectionLabel(section: Section): string {
  if (section.date) return `${section.heading ? `${section.heading} — ` : ""}${section.date}`;
  return section.heading || "Places to visit";
}

function placesWithCoords(section: Section): PlaceBlock[] {
  return section.blocks.filter(
    (b): b is PlaceBlock => isPlaceBlock(b) && !!b.place.geometry?.location && !!b.place.place_id,
  );
}

function resolveScope(trip: TripPlan, day?: string): Section[] {
  if (!day) {
    return trip.itinerary.sections.filter(
      (s) => s.mode === "dayPlan" && placesWithCoords(s).length >= 2,
    );
  }
  try {
    const resolved = resolveDay(trip, day);
    const found = findDaySectionByDate(trip, resolved.date!);
    if (found) return [found.section];
  } catch {
    // fall through to section headings
  }
  const bySection = resolveSectionRef(trip, day);
  if (bySection.kind === "unique") return [bySection.match.section];
  throw new WanderlogValidationError(`No day or list matching "${day}" in "${trip.title}".`);
}

function fmtTotal(seconds: number, metres: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  const time = h > 0 ? `${h}h ${m}m` : `${m} min`;
  const km = metres / 1000;
  return `${time}, ${km >= 10 ? km.toFixed(0) : km.toFixed(1)} km`;
}

export async function getTravelTimes(
  ctx: AppContext,
  args: Args,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const entry = await ctx.tripCache.getEntry(args.trip_key);
    const trip = entry.snapshot;
    const defaultMode = trip.itinerary.options?.defaultTravelMode;
    const mode: TravelMode = args.travel_mode
      ?? (TRAVEL_MODES.includes(defaultMode as TravelMode) ? (defaultMode as TravelMode) : "driving");

    const sections = resolveScope(trip, args.day);
    const runs = sections
      .map((section) => ({ section, places: placesWithCoords(section) }))
      .filter((r) => r.places.length >= 2);
    if (runs.length === 0) {
      const scope = args.day ? `"${args.day}"` : "any day";
      return {
        content: [
          { type: "text", text: `${scope} in "${trip.title}" has fewer than two places with locations — nothing to route.` },
        ],
      };
    }

    const legs = await ctx.rest.getDistances({
      travelMode: mode,
      placeRuns: runs.map((r) => ({
        sectionId: r.section.id,
        places: r.places.map((p) => ({
          id: p.place.place_id,
          longitude: p.place.geometry!.location.lng,
          latitude: p.place.geometry!.location.lat,
        })),
      })),
    });

    const out: string[] = [`Travel times in "${trip.title}" (${mode}):`];
    for (const run of runs) {
      const rows: Leg[] = [];
      let missing = 0;
      for (let i = 0; i < run.places.length - 1; i++) {
        const a = run.places[i]!;
        const b = run.places[i + 1]!;
        const leg: DistanceLeg | undefined = legs[legKey(a.place.place_id, b.place.place_id, mode)];
        const route = leg?.route;
        if (!route?.distance || !route.duration) {
          missing++;
          rows.push({
            from: a.place.name,
            to: b.place.name,
            distanceText: "?",
            durationText: "no route",
            distanceM: 0,
            durationS: 0,
          });
          continue;
        }
        rows.push({
          from: a.place.name,
          to: b.place.name,
          distanceText: route.distance.text,
          durationText: route.duration.text,
          distanceM: route.distance.value,
          durationS: route.duration.value,
        });
      }
      const totalS = rows.reduce((s, r) => s + r.durationS, 0);
      const totalM = rows.reduce((s, r) => s + r.distanceM, 0);
      out.push("", `${sectionLabel(run.section)} — total ${fmtTotal(totalS, totalM)}${missing ? ` (${missing} leg(s) unroutable)` : ""}`);
      for (const r of rows) {
        out.push(`  ${r.from} → ${r.to}: ${r.durationText} (${r.distanceText})`);
      }
    }
    out.push("", "Reorder with wanderlog_reorder_places or move places with wanderlog_move_place to shorten long days.");
    return { content: [{ type: "text", text: out.join("\n") }] };
  } catch (err) {
    const msg =
      err instanceof WanderlogError
        ? err.toUserMessage()
        : `Unexpected error: ${(err as Error).message}`;
    return { content: [{ type: "text", text: msg }], isError: true };
  }
}
