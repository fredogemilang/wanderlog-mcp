import { z } from "zod";
import type { AppContext } from "../context.js";
import { WanderlogError, WanderlogValidationError } from "../errors.js";
import { resolvePlaceRef } from "../resolvers/place-ref.js";
import type { ExplorePage, PlacesListEntry, TripPlan } from "../types.js";
import { isPlaceBlock } from "../types.js";

export const exploreInputSchema = {
  trip_key: z
    .string()
    .min(1)
    .describe("The trip whose destination to explore. Recommendations come from Wanderlog's curated data for that destination."),
  category: z
    .string()
    .optional()
    .describe(
      "What to look for: 'attractions', 'restaurants', 'cafes', 'temples', 'gardens', 'bakeries', 'photo spots', 'kid-friendly', 'nightlife', … Matched against Wanderlog's category list for the destination. Omit to get an overview (top attractions + top restaurants + available categories).",
    ),
  near: z
    .string()
    .optional()
    .describe(
      "Natural-language reference to a place already in the trip (e.g. 'the hotel', 'Fushimi Inari'). Returns recommended places close to it instead of a category list.",
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .default(15)
    .describe("Maximum places to return (default 15)."),
  response_format: z
    .enum(["concise", "detailed"])
    .default("concise")
    .describe(
      "'concise' lists name, rating, and a one-line description. 'detailed' adds address, typical visit duration, price level, website, source snippets, and the place_id for exact wanderlog_add_place calls.",
    ),
};

export const exploreDescription = `
Recommends things to do at a trip's destination using Wanderlog's curated "Explore" data —
the same ranked lists shown in the app (aggregated from travel sites like Lonely Planet,
Time Out, etc.), with ratings, typical visit durations, and short descriptions.

Three modes:
  1. Overview (no category/near): top attractions, top restaurants, and the category names
     available for this destination.
  2. Category: "temples", "cafes", "bakeries", "romantic places", "kid-friendly" … returns the
     ranked list for that category.
  3. Near a place (near="the hotel"): places recommended close to something already in the trip.

Use this before wanderlog_add_place when the user asks for ideas ("what should we do in
Kyoto?", "good coffee near our hotel?"). Places already in the trip are marked ✔.
`.trim();

type Args = {
  trip_key: string;
  category?: string;
  near?: string;
  limit?: number;
  response_format?: "concise" | "detailed";
};

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function placeIdsInTrip(trip: TripPlan): Set<string> {
  const ids = new Set<string>();
  for (const s of trip.itinerary.sections) {
    for (const b of s.blocks) {
      if (isPlaceBlock(b) && b.place.place_id) ids.add(b.place.place_id);
    }
  }
  return ids;
}

type CategoryHit = { id: number; name: string; kind: "category" | "searched" };

export function matchCategory(page: ExplorePage, query: string): CategoryHit[] {
  const q = norm(query);
  const all: CategoryHit[] = [
    ...(page.categories ?? []).map((c) => ({ id: c.id, name: c.shortName || c.name, kind: "category" as const })),
    ...(page.searchedCategories ?? []).map((c) => ({ id: c.id, name: c.name, kind: "searched" as const })),
  ];
  const aliases: Record<string, string[]> = {
    attractions: ["attraction", "things to do", "sights", "sightseeing", "landmarks"],
    restaurants: ["restaurant", "food", "eat", "dining", "where to eat"],
    cafes: ["cafe", "coffee", "coffee shops"],
    "photo spots": ["photo", "photography", "instagram"],
    "kid-friendly attractions": ["kids", "kid friendly", "family", "children"],
    "romantic places": ["romantic", "date"],
    nightlife: ["bars", "night", "drinks"],
  };
  const expanded = new Set<string>([q]);
  for (const [canon, alts] of Object.entries(aliases)) {
    if (norm(canon) === q || alts.some((a) => norm(a) === q)) expanded.add(norm(canon));
  }
  const exact = all.filter((c) => expanded.has(norm(c.name)));
  if (exact.length > 0) return exact;
  const singular = q.replace(/s$/, "");
  return all.filter((c) => {
    const n = norm(c.name);
    return n.includes(q) || n.includes(singular) || q.includes(n);
  });
}

function priceLabel(level: number | null | undefined): string | null {
  if (level === null || level === undefined) return null;
  return "$".repeat(Math.max(1, Math.min(4, level)));
}

function durationLabel(min?: number | null, max?: number | null): string | null {
  if (!min && !max) return null;
  const fmt = (m: number) => (m >= 60 ? `${Math.round((m / 60) * 10) / 10}h` : `${m}m`);
  if (min && max && min !== max) return `${fmt(min)}–${fmt(max)}`;
  return fmt((min ?? max)!);
}

export function formatEntry(
  e: PlacesListEntry,
  index: number,
  inTrip: boolean,
  format: "concise" | "detailed",
): string {
  const mark = inTrip ? " ✔ in trip" : "";
  const rating = e.rating ? ` ★${e.rating}${e.numRatings ? ` (${e.numRatings.toLocaleString()})` : ""}` : "";
  const cats = e.categories && e.categories.length > 0 ? ` · ${e.categories.slice(0, 2).join(", ")}` : "";
  const desc = (e.generatedDescription || e.description || e.sources?.[0]?.snippet || "").trim();
  const shortDesc = desc.length > 160 && format === "concise" ? `${desc.slice(0, 157)}…` : desc;
  const lines = [`${index}. ${e.name}${rating}${cats}${mark}`];
  if (shortDesc) lines.push(`   ${shortDesc}`);
  if (format === "detailed") {
    const bits: string[] = [];
    const dur = durationLabel(e.minMinutesSpent, e.maxMinutesSpent);
    if (dur) bits.push(`typical visit ${dur}`);
    const price = priceLabel(e.priceLevel);
    if (price) bits.push(price);
    if (e.tripadvisorRating) bits.push(`TripAdvisor ${e.tripadvisorRating}`);
    if (e.permanentlyClosed || (e.businessStatus && e.businessStatus !== "OPERATIONAL")) {
      bits.push(`status: ${e.businessStatus ?? "closed"}`);
    }
    if (bits.length > 0) lines.push(`   ${bits.join(" · ")}`);
    if (e.address) lines.push(`   ${e.address}`);
    if (e.website) lines.push(`   ${e.website}`);
    const src = (e.sources ?? []).filter((s) => s.siteName).slice(0, 3);
    if (src.length > 0) {
      lines.push(`   Mentioned by: ${src.map((s) => s.siteName).join(", ")}`);
    }
    lines.push(`   place_id: ${e.placeId}`);
  }
  return lines.join("\n");
}

export async function explore(
  ctx: AppContext,
  args: Args,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const limit = args.limit ?? 15;
    const format = args.response_format ?? "concise";
    const entry = await ctx.tripCache.getEntry(args.trip_key);
    const trip = entry.snapshot;
    const geo = entry.geos?.[0];
    if (!geo) {
      throw new WanderlogValidationError(
        `"${trip.title}" has no destination geo to explore`,
        "Wanderlog's Explore data is per destination; this trip was created without one.",
      );
    }
    const inTrip = placeIdsInTrip(trip);

    if (args.near) {
      const resolved = resolvePlaceRef(trip, args.near);
      if (resolved.kind !== "unique" || !isPlaceBlock(resolved.match.block)) {
        const hint = resolved.kind === "ambiguous"
          ? `Several places match "${args.near}" — be more specific.`
          : `No place matching "${args.near}" in the trip.`;
        throw new WanderlogValidationError(hint);
      }
      const anchor = resolved.match.block.place;
      const loc = anchor.geometry?.location;
      if (!loc) throw new WanderlogValidationError(`"${anchor.name}" has no coordinates.`);
      const recs = await ctx.rest.getRecommendationsNear({
        tripPlanId: trip.id,
        geoId: geo.id,
        longitude: loc.lng,
        latitude: loc.lat,
        excludingPlaceIds: [...inTrip],
      });
      const shown = recs.slice(0, limit);
      if (shown.length === 0) {
        return { content: [{ type: "text", text: `No recommendations found near ${anchor.name}.` }] };
      }
      const km = (lat: number, lng: number) => {
        const R = 6371;
        const dLat = ((lat - loc.lat) * Math.PI) / 180;
        const dLng = ((lng - loc.lng) * Math.PI) / 180;
        const a = Math.sin(dLat / 2) ** 2 +
          Math.cos((loc.lat * Math.PI) / 180) * Math.cos((lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
        return 2 * R * Math.asin(Math.sqrt(a));
      };
      const lines = shown.map((r, i) => {
        const d = km(r.latitude, r.longitude);
        const dist = d < 1 ? `${Math.round(d * 1000)} m` : `${d.toFixed(1)} km`;
        return `${i + 1}. ${r.name} — ${dist} away${format === "detailed" ? `\n   place_id: ${r.placeId}` : ""}`;
      });
      return {
        content: [
          {
            type: "text",
            text: `Recommended near ${anchor.name} (${geo.name}):\n${lines.join("\n")}\n\nUse wanderlog_get_place_details for hours/ratings, or wanderlog_add_place to add one.`,
          },
        ],
      };
    }

    const page = await ctx.rest.getExplorePage(geo.id, args.trip_key);

    if (!args.category) {
      const out: string[] = [`Explore ${page.geo.name}${page.geo.countryName ? `, ${page.geo.countryName}` : ""}`];
      for (const section of page.sections ?? []) {
        const blocks = (section.places?.blocks ?? []).filter((b) => b.place?.name);
        if (blocks.length === 0) continue;
        out.push("", `${section.places?.heading ?? section.type}:`);
        blocks.slice(0, Math.min(limit, 10)).forEach((b, i) => {
          const mark = b.place?.placeId && inTrip.has(b.place.placeId) ? " ✔ in trip" : "";
          out.push(`  ${i + 1}. ${b.place!.name}${mark}`);
        });
      }
      const catNames = (page.categories ?? []).map((c) => c.shortName || c.name);
      const searched = (page.searchedCategories ?? []).map((c) => c.name);
      if (catNames.length > 0) {
        out.push("", `Categories (pass one as category): ${catNames.join(", ")}`);
      }
      if (searched.length > 0) out.push(`Also popular here: ${searched.join(", ")}`);
      const lists = (page.placesLists ?? []).filter((l) => l.type !== "geoCategory").slice(0, 8);
      if (lists.length > 0) {
        out.push("", "Community itineraries & guides (see wanderlog_search_guides):");
        for (const l of lists) out.push(`  • ${l.title}${l.placeCount ? ` (${l.placeCount} places)` : ""}`);
      }
      return { content: [{ type: "text", text: out.join("\n") }] };
    }

    const hits = matchCategory(page, args.category);
    if (hits.length === 0) {
      const names = (page.categories ?? []).map((c) => c.shortName || c.name);
      throw new WanderlogError(
        `No Explore category matching "${args.category}" for ${page.geo.name}`,
        "category_not_found",
        {
          hint: `Available: ${names.join(", ")}`,
          followUps: [
            `Call wanderlog_search_places with query "${args.category}" for a free-text place search instead.`,
          ],
        },
      );
    }
    if (hits.length > 1) {
      const lines = hits.slice(0, 10).map((h) => `  • ${h.name}`);
      return {
        content: [
          { type: "text", text: `Several categories match "${args.category}":\n${lines.join("\n")}\n\nRetry with one of these names.` },
        ],
      };
    }

    const list = await ctx.rest.getPlacesList("geoCategory", hits[0]!.id, geo.id);
    const entries = (list.placeMetadata ?? []).filter((e) => !e.permanentlyClosed);
    const shown = entries.slice(0, limit);
    if (shown.length === 0) {
      return { content: [{ type: "text", text: `"${list.title}" has no places listed.` }] };
    }
    const lines = shown.map((e, i) => formatEntry(e, i + 1, inTrip.has(e.placeId), format));
    const more = entries.length > shown.length ? `\n\n(${entries.length - shown.length} more — raise limit to see them.)` : "";
    const tail = format === "concise"
      ? "\n\nUse response_format 'detailed' for addresses, visit durations, and place_ids."
      : "";
    return {
      content: [{ type: "text", text: `${list.title}\n\n${lines.join("\n")}${more}${tail}` }],
    };
  } catch (err) {
    const msg =
      err instanceof WanderlogError
        ? err.toUserMessage()
        : `Unexpected error: ${(err as Error).message}`;
    return { content: [{ type: "text", text: msg }], isError: true };
  }
}
