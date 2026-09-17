import type { Block, Section, TripPlan } from "../types.js";
import {
  isFlightBlock,
  isPlaceBlock,
  isRentalCarBlock,
  isTransitBlock,
} from "../types.js";
import { parseOrdinal, resolvePlaceRef, type PlaceRefMatch } from "./place-ref.js";

export type ReservationKind = "flight" | "ferry" | "bus" | "train" | "rentalCar" | "hotel";

export type ReservationMatch = PlaceRefMatch & { kind: ReservationKind };

export type ReservationRefResult =
  | { kind: "unique"; match: ReservationMatch }
  | { kind: "ambiguous"; candidates: ReservationMatch[] }
  | { kind: "none" };

export function reservationKind(block: Block): ReservationKind | null {
  if (isFlightBlock(block)) return "flight";
  if (isTransitBlock(block)) return block.type;
  if (isRentalCarBlock(block)) return "rentalCar";
  if (isPlaceBlock(block) && block.hotel) return "hotel";
  return null;
}

/** Human label used both for matching and for disambiguation lists. */
export function describeReservation(block: Block): string {
  if (isFlightBlock(block)) {
    const airline = block.flightInfo?.airline;
    const code = [airline?.iata, block.flightInfo?.number].filter(Boolean).join("");
    const name = airline?.name ?? airline?.iata ?? "Flight";
    const route = [block.depart?.airport?.iata ?? block.depart?.airport?.name, block.arrive?.airport?.iata ?? block.arrive?.airport?.name]
      .filter(Boolean)
      .join(" → ");
    return [`${name}${code ? ` ${code}` : ""}`, route, block.depart?.date].filter(Boolean).join(" · ");
  }
  if (isTransitBlock(block)) {
    const route = [block.depart?.place?.name, block.arrive?.place?.name].filter(Boolean).join(" → ");
    return [block.carrier ?? block.type, route, block.depart?.date].filter(Boolean).join(" · ");
  }
  if (isRentalCarBlock(block)) {
    const route = [block.pickUp?.place?.name, block.dropOff?.place?.name].filter(Boolean).join(" → ");
    return ["Rental car", route, block.pickUp?.date].filter(Boolean).join(" · ");
  }
  if (isPlaceBlock(block) && block.hotel) {
    const stay = [block.hotel.checkIn, block.hotel.checkOut].filter(Boolean).join(" → ");
    return [block.place.name, stay].filter(Boolean).join(" · ");
  }
  return `block #${block.id}`;
}

function searchableText(block: Block): string {
  const parts: string[] = [describeReservation(block)];
  if (isFlightBlock(block)) {
    parts.push(
      block.flightInfo?.airline?.name ?? "",
      block.flightInfo?.airline?.iata ?? "",
      String(block.flightInfo?.number ?? ""),
      block.depart?.airport?.name ?? "",
      block.depart?.airport?.cityName ?? "",
      block.arrive?.airport?.name ?? "",
      block.arrive?.airport?.cityName ?? "",
      block.confirmationNumber ?? "",
    );
  } else if (isTransitBlock(block)) {
    parts.push(
      block.carrier ?? "",
      block.depart?.place?.name ?? "",
      block.arrive?.place?.name ?? "",
      block.confirmationNumber ?? "",
    );
  } else if (isRentalCarBlock(block)) {
    parts.push(
      block.pickUp?.place?.name ?? "",
      block.dropOff?.place?.name ?? "",
      block.confirmationNumber ?? "",
    );
  } else if (isPlaceBlock(block)) {
    parts.push(block.place.name, block.hotel?.confirmationNumber ?? "");
  }
  return normalize(parts.join(" "));
}

function normalize(s: string): string {
  return s.replace(/[\s\-–—]+/g, " ").trim().toLowerCase();
}

const STOPWORDS = new Set(["the", "my", "a", "to", "from", "on", "at", "in", "via", "with"]);

function allReservations(trip: TripPlan): ReservationMatch[] {
  const out: ReservationMatch[] = [];
  trip.itinerary.sections.forEach((section: Section, sectionIndex) => {
    section.blocks.forEach((block, blockIndex) => {
      const kind = reservationKind(block);
      if (kind) out.push({ sectionIndex, blockIndex, section, block, kind });
    });
  });
  return out;
}

function withKind(match: PlaceRefMatch): ReservationMatch | null {
  const kind = reservationKind(match.block);
  return kind ? { ...match, kind } : null;
}

/**
 * Resolves a reference to a reservation block: flights, ferries/buses/trains,
 * rental cars, and hotel stays. Tries the place resolver first (so role
 * keywords like "the hotel"/"the flight", ordinals, and "X on day N" keep
 * working), then falls back to a substring search across carrier, airline,
 * flight number, endpoint names, and confirmation numbers.
 */
export function resolveReservationRef(trip: TripPlan, ref: string): ReservationRefResult {
  const viaPlace = resolvePlaceRef(trip, ref);
  if (viaPlace.kind === "unique") {
    const m = withKind(viaPlace.match);
    if (m) return { kind: "unique", match: m };
  } else if (viaPlace.kind === "ambiguous") {
    const ms = viaPlace.candidates.map(withKind).filter((m): m is ReservationMatch => !!m);
    if (ms.length === 1) return { kind: "unique", match: ms[0]! };
    if (ms.length > 1) return { kind: "ambiguous", candidates: ms };
  }

  const normalized = normalize(ref);
  if (!normalized) return { kind: "none" };
  const ordinal = parseOrdinal(normalized);
  const body = ordinal ? ordinal.rest : normalized;

  const pool = allReservations(trip);
  const typeWords: Record<string, ReservationKind[]> = {
    flight: ["flight"],
    flights: ["flight"],
    train: ["train"],
    ferry: ["ferry"],
    bus: ["bus"],
    car: ["rentalCar"],
    "rental car": ["rentalCar"],
    hotel: ["hotel"],
    lodging: ["hotel"],
    reservation: ["flight", "ferry", "bus", "train", "rentalCar", "hotel"],
  };
  const words = body.split(" ");
  const typeFilter = new Set<ReservationKind>();
  const searchTerms: string[] = [];
  for (const w of words) {
    const kinds = typeWords[w];
    if (kinds) kinds.forEach((k) => typeFilter.add(k));
    else if (!STOPWORDS.has(w)) searchTerms.push(w);
  }

  let candidates = typeFilter.size > 0 ? pool.filter((m) => typeFilter.has(m.kind)) : pool;
  if (searchTerms.length > 0) {
    candidates = candidates.filter((m) => {
      const text = searchableText(m.block);
      return searchTerms.every((t) => text.includes(t));
    });
  }

  if (ordinal) {
    if (candidates.length === 0) return { kind: "none" };
    const index = ordinal.position === "last" ? candidates.length - 1 : ordinal.position - 1;
    if (index < 0 || index >= candidates.length) return { kind: "none" };
    return { kind: "unique", match: candidates[index]! };
  }
  if (candidates.length === 0) return { kind: "none" };
  if (candidates.length === 1) return { kind: "unique", match: candidates[0]! };
  return { kind: "ambiguous", candidates: candidates.slice(0, 10) };
}
