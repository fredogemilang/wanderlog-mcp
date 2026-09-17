import { describe, expect, it, vi } from "vitest";
import type { AppContext } from "../../src/context.ts";
import { applyOp, type Json0Op } from "../../src/ot/apply.ts";
import { resolveReservationRef } from "../../src/resolvers/reservation-ref.ts";
import { deleteTrip } from "../../src/tools/delete-trip.ts";
import { editChecklist, findChecklists } from "../../src/tools/edit-checklist.ts";
import { editReservation } from "../../src/tools/edit-reservation.ts";
import { formatPlaceDetails, getPlaceDetails } from "../../src/tools/get-place-details.ts";
import { updateTrip } from "../../src/tools/update-trip.ts";
import type { ChecklistBlock, FlightBlock, PlaceBlock, TransitBlock, TripPlan } from "../../src/types.ts";
import { checklistTrip } from "../fixtures/checklist-trip.ts";
import { mixedBlocksTrip } from "../fixtures/mixed-blocks-trip.ts";

function fresh<T>(v: T): T {
  return structuredClone(v);
}

function makeFakeContext(trip: TripPlan, rest: Record<string, unknown> = {}) {
  const submittedOps: Json0Op[][] = [];
  const entry = {
    snapshot: structuredClone(trip),
    version: 1,
    geos: [{ id: 1, name: "Barcelona", latitude: 41.38, longitude: 2.17 }],
  };
  const invalidate = vi.fn();
  const evict = vi.fn();
  const ctx = {
    userId: 3656632,
    rest,
    pool: {
      get: () => ({
        isSubscribed: true,
        version: 1,
        async submit(ops: Json0Op[]) {
          submittedOps.push(ops);
        },
      }),
      evict,
    },
    tripCache: {
      getEntry: async () => entry,
      applyLocalOp: (_key: string, ops: Json0Op[], version: number) => {
        entry.snapshot = applyOp(entry.snapshot, ops);
        entry.version = version;
      },
      invalidate,
    },
  } as unknown as AppContext;
  return { ctx, submittedOps, entry, invalidate, evict };
}

// ---------------------------------------------------------------------------
// delete_trip
// ---------------------------------------------------------------------------

describe("delete_trip", () => {
  it("refuses when confirm_title does not match and calls nothing", async () => {
    const deleteTripFn = vi.fn();
    const { ctx } = makeFakeContext(checklistTrip, {
      getTrip: async () => fresh(checklistTrip),
      deleteTrip: deleteTripFn,
    });
    const res = await deleteTrip(ctx, { trip_key: "T", confirm_title: "Wrong title" });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain("does not match");
    expect(deleteTripFn).not.toHaveBeenCalled();
  });

  it("deletes, then drops the cache entry and live subscription", async () => {
    const deleteTripFn = vi.fn(async () => {});
    const { ctx, invalidate, evict } = makeFakeContext(checklistTrip, {
      getTrip: async () => fresh(checklistTrip),
      deleteTrip: deleteTripFn,
    });
    const res = await deleteTrip(ctx, {
      trip_key: "T",
      confirm_title: "  trip to BARCELONA ",
    });
    expect(res.isError).toBeUndefined();
    expect(deleteTripFn).toHaveBeenCalledWith("T");
    expect(invalidate).toHaveBeenCalledWith("T");
    expect(evict).toHaveBeenCalledWith("T");
    expect(res.content[0]!.text).toContain("Deleted trip");
  });
});

// ---------------------------------------------------------------------------
// get_place_details
// ---------------------------------------------------------------------------

describe("get_place_details", () => {
  const detail = {
    name: "Sagrada Família",
    place_id: "ChIJk_s92NyipBIRUMnDG8Kq2Js",
    formatted_address: "C/ de Mallorca, 401, Barcelona",
    rating: 4.7,
    user_ratings_total: 200000,
    website: "https://sagradafamilia.org",
    international_phone_number: "+34 932 08 04 14",
    opening_hours: { weekday_text: ["Monday: 9:00 AM – 6:00 PM", "Tuesday: 9:00 AM – 6:00 PM"] },
    types: ["church", "tourist_attraction"],
    geometry: { location: { lat: 41.4036, lng: 2.1744 } },
  };

  it("requires place or place_id", async () => {
    const { ctx } = makeFakeContext(checklistTrip);
    const res = await getPlaceDetails(ctx, { trip_key: "T" });
    expect(res.isError).toBe(true);
  });

  it("uses place_id directly when given", async () => {
    const getPlaceDetailsFn = vi.fn(async () => detail);
    const { ctx } = makeFakeContext(checklistTrip, { getPlaceDetails: getPlaceDetailsFn });
    const res = await getPlaceDetails(ctx, { trip_key: "T", place_id: detail.place_id });
    expect(getPlaceDetailsFn).toHaveBeenCalledWith(detail.place_id);
    expect(res.content[0]!.text).toContain("Monday: 9:00 AM");
    expect(res.content[0]!.text).toContain("+34 932 08 04 14");
  });

  it("prefers a place already in the trip and refetches by its place_id", async () => {
    const trip = fresh(checklistTrip);
    const inTrip = trip.itinerary.sections
      .flatMap((s) => s.blocks)
      .find((b): b is PlaceBlock => b.type === "place")!;
    const getPlaceDetailsFn = vi.fn(async () => ({ ...detail, name: inTrip.place.name }));
    const autocomplete = vi.fn();
    const { ctx } = makeFakeContext(trip, {
      getPlaceDetails: getPlaceDetailsFn,
      searchPlacesAutocomplete: autocomplete,
    });
    const res = await getPlaceDetails(ctx, { trip_key: "T", place: inTrip.place.name });
    expect(getPlaceDetailsFn).toHaveBeenCalledWith(inTrip.place.place_id);
    expect(autocomplete).not.toHaveBeenCalled();
    expect(res.content[0]!.text).toContain(`in "${trip.title}"`);
  });

  it("falls back to search when the place is not in the trip", async () => {
    const trip = fresh(checklistTrip);
    const autocomplete = vi.fn(async () => [{ place_id: detail.place_id, description: "Sagrada" }]);
    const getPlaceDetailsFn = vi.fn(async () => detail);
    const { ctx } = makeFakeContext(trip, {
      searchPlacesAutocomplete: autocomplete,
      getPlaceDetails: getPlaceDetailsFn,
    });
    const res = await getPlaceDetails(ctx, { trip_key: "T", place: "Bar del Pla" });
    expect(autocomplete).toHaveBeenCalled();
    expect(res.content[0]!.text).toContain("not in the trip");
  });

  it("formats without optional fields", () => {
    const text = formatPlaceDetails({ name: "X", place_id: "p1" }, "test");
    expect(text).toContain("X");
    expect(text).not.toContain("Rating");
    expect(text).not.toContain("Opening hours");
  });
});

// ---------------------------------------------------------------------------
// update_trip
// ---------------------------------------------------------------------------

describe("update_trip", () => {
  it("requires at least one field", async () => {
    const { ctx, submittedOps } = makeFakeContext(checklistTrip);
    const res = await updateTrip(ctx, { trip_key: "T" });
    expect(res.isError).toBe(true);
    expect(submittedOps).toHaveLength(0);
  });

  it("emits top-level title and privacy replacement ops", async () => {
    const { ctx, submittedOps, entry } = makeFakeContext(checklistTrip);
    const res = await updateTrip(ctx, {
      trip_key: "T",
      title: "Barcelona 2026",
      privacy: "public",
    });
    expect(res.isError).toBeUndefined();
    expect(submittedOps).toHaveLength(1);
    expect(submittedOps[0]).toEqual([
      { p: ["title"], od: "Trip to Barcelona", oi: "Barcelona 2026" },
      { p: ["privacy"], od: checklistTrip.privacy, oi: "public" },
    ]);
    expect(entry.snapshot.title).toBe("Barcelona 2026");
    expect(entry.snapshot.privacy).toBe("public");
  });

  it("is a no-op when values already match", async () => {
    const { ctx, submittedOps } = makeFakeContext(checklistTrip);
    const res = await updateTrip(ctx, { trip_key: "T", title: checklistTrip.title });
    expect(res.isError).toBeUndefined();
    expect(res.content[0]!.text).toContain("no change");
    expect(submittedOps).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// edit_checklist
// ---------------------------------------------------------------------------

function sectionOfType(trip: TripPlan, type: string) {
  return trip.itinerary.sections.find((s) => s.type === type)!;
}

function checklistIn(trip: TripPlan): ChecklistBlock {
  return trip.itinerary.sections
    .flatMap((s) => s.blocks)
    .find((b): b is ChecklistBlock => b.type === "checklist")!;
}

describe("edit_checklist", () => {
  it("finds both fixture checklists, and scopes by day", () => {
    const targets = findChecklists(checklistTrip);
    expect(targets.map((t) => t.block.title)).toEqual(["Packing list", ""]);
    expect(findChecklists(checklistTrip, "2026-06-03")).toHaveLength(1);
  });

  it("requires an edit", async () => {
    const { ctx } = makeFakeContext(checklistTrip);
    const res = await editChecklist(ctx, { trip_key: "T" });
    expect(res.isError).toBe(true);
  });

  it("checks, unchecks, adds, removes and renames in one batch", async () => {
    const { ctx, submittedOps, entry } = makeFakeContext(checklistTrip);
    const res = await editChecklist(ctx, {
      trip_key: "T",
      checklist: "Packing list",
      check: ["comfortable shoes"],
      uncheck: ["tickets"],
      remove_items: ["offline map"],
      add_items: ["Travel insurance", "Passport"],
      new_title: "Pre-trip",
    });
    expect(res.isError).toBeUndefined();
    expect(submittedOps).toHaveLength(1);

    const after = checklistIn(entry.snapshot);
    expect(after.title).toBe("Pre-trip");
    const items = after.items.map((i) => ({
      text: (i.text!.ops![0]!.insert as string).trim(),
      checked: i.checked,
    }));
    expect(items).toEqual([
      { text: "Book tickets online", checked: false },
      { text: "Pack comfortable shoes", checked: true },
      { text: "Travel insurance", checked: false },
      { text: "Passport", checked: false },
    ]);
  });

  it("skips toggles that already have the requested state", async () => {
    const { ctx, submittedOps } = makeFakeContext(checklistTrip);
    const res = await editChecklist(ctx, { trip_key: "T", checklist: "packing", check: ["Book tickets"] });
    expect(res.isError).toBeUndefined();
    expect(res.content[0]!.text).toContain("no change");
    expect(submittedOps).toHaveLength(0);
  });

  it("errors on an unknown item without submitting", async () => {
    const { ctx, submittedOps } = makeFakeContext(checklistTrip);
    const res = await editChecklist(ctx, { trip_key: "T", checklist: "packing", check: ["Snorkel"] });
    expect(res.isError).toBe(true);
    expect(submittedOps).toHaveLength(0);
  });

  it("lists candidates when several checklists match", async () => {
    const trip = fresh(checklistTrip);
    const original = checklistIn(trip);
    trip.itinerary.sections[1]!.blocks.push({
      ...structuredClone(original),
      id: 60099,
      title: "Packing list (kids)",
    });
    const { ctx, submittedOps } = makeFakeContext(trip);
    const res = await editChecklist(ctx, { trip_key: "T", checklist: "packing", check: ["shoes"] });
    expect(res.isError).toBeUndefined();
    expect(res.content[0]!.text).toContain("Several checklists");
    expect(submittedOps).toHaveLength(0);

    const exact = await editChecklist(ctx, {
      trip_key: "T",
      checklist: "Packing list",
      check: ["shoes"],
    });
    expect(exact.isError).toBeUndefined();
    expect(submittedOps).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// reservation resolver + edit_reservation
// ---------------------------------------------------------------------------

describe("resolveReservationRef", () => {
  it("resolves role keywords via the place resolver", () => {
    const r = resolveReservationRef(mixedBlocksTrip, "the flight");
    expect(r.kind).toBe("unique");
    if (r.kind === "unique") expect(r.match.kind).toBe("flight");
  });

  it("matches by airline code and flight number", () => {
    const r = resolveReservationRef(mixedBlocksTrip, "NH 890");
    expect(r.kind).toBe("unique");
    if (r.kind === "unique") expect(r.match.block.id).toBe(893453814);
  });

  it("matches transit by carrier and endpoint", () => {
    const r = resolveReservationRef(mixedBlocksTrip, "train to Odawara");
    expect(r.kind).toBe("unique");
    if (r.kind === "unique") expect(r.match.kind).toBe("train");
  });

  it("matches a hotel by name", () => {
    const r = resolveReservationRef(mixedBlocksTrip, "Far East Village");
    expect(r.kind).toBe("unique");
    if (r.kind === "unique") expect(r.match.kind).toBe("hotel");
  });

  it("does not resolve plain places", () => {
    const r = resolveReservationRef(mixedBlocksTrip, "Sensō-ji");
    expect(r.kind).toBe("none");
  });
});

describe("edit_reservation", () => {
  it("requires a field", async () => {
    const { ctx } = makeFakeContext(mixedBlocksTrip);
    const res = await editReservation(ctx, { trip_key: "T", reservation: "the flight" });
    expect(res.isError).toBe(true);
  });

  it("patches flight endpoints, airline and confirmation without clobbering siblings", async () => {
    const { ctx, submittedOps, entry } = makeFakeContext(mixedBlocksTrip);
    const res = await editReservation(ctx, {
      trip_key: "T",
      reservation: "the flight",
      start_time: "20:30",
      end_date: "2025-11-14",
      carrier: "JL",
      flight_number: "42",
      confirmation_number: "NEW999",
      traveler_names: ["Ali", "Sam"],
      notes: "Seat 12A",
    });
    expect(res.isError).toBeUndefined();
    expect(submittedOps).toHaveLength(1);
    const flight = sectionOfType(entry.snapshot, "flights").blocks[0] as FlightBlock;
    expect(flight.depart).toEqual({
      date: "2025-11-13",
      time: "20:30",
      airport: { iata: "SYD", name: "Sydney Airport", cityName: "Sydney" },
    });
    expect(flight.arrive?.time).toBe("05:00");
    expect(flight.flightInfo).toEqual({ airline: { iata: "JL" }, number: 42 });
    expect(flight.confirmationNumber).toBe("NEW999");
    expect(flight.travelerNames).toEqual(["Ali", "Sam"]);
    expect(flight.text?.ops?.[0]?.insert).toBe("Seat 12A\n");
    // Exactly one op per path — airline + number must not fight over flightInfo.
    const paths = submittedOps[0]!.map((o) => o.p.join("/"));
    expect(new Set(paths).size).toBe(paths.length);
  });

  it("rejects arrival before departure", async () => {
    const { ctx, submittedOps } = makeFakeContext(mixedBlocksTrip);
    const res = await editReservation(ctx, {
      trip_key: "T",
      reservation: "the flight",
      end_date: "2025-11-12",
    });
    expect(res.isError).toBe(true);
    expect(submittedOps).toHaveLength(0);
  });

  it("updates a train's carrier and clears its confirmation", async () => {
    const trip = fresh(mixedBlocksTrip);
    (sectionOfType(trip, "transit").blocks[0] as TransitBlock).confirmationNumber = "OLD";
    const { ctx, entry } = makeFakeContext(trip);
    const res = await editReservation(ctx, {
      trip_key: "T",
      reservation: "the train",
      carrier: "JR East",
      confirmation_number: "",
    });
    expect(res.isError).toBeUndefined();
    const train = sectionOfType(entry.snapshot, "transit").blocks[0] as TransitBlock;
    expect(train.carrier).toBe("JR East");
    expect("confirmationNumber" in train).toBe(false);
  });

  it("edits hotel stay fields inside the hotel sub-object", async () => {
    const { ctx, entry } = makeFakeContext(mixedBlocksTrip);
    const res = await editReservation(ctx, {
      trip_key: "T",
      reservation: "the hotel",
      start_date: "2025-11-15",
      end_date: "2025-11-17",
      confirmation_number: "H-777",
    });
    expect(res.isError).toBeUndefined();
    const hotel = sectionOfType(entry.snapshot, "hotels").blocks[0] as PlaceBlock;
    expect(hotel.hotel).toEqual({
      checkIn: "2025-11-15",
      checkOut: "2025-11-17",
      travelerNames: ["Ali"],
      confirmationNumber: "H-777",
    });
  });

  it("rejects times and flight fields on hotels", async () => {
    const { ctx, submittedOps } = makeFakeContext(mixedBlocksTrip);
    const res = await editReservation(ctx, {
      trip_key: "T",
      reservation: "the hotel",
      start_time: "15:00",
    });
    expect(res.isError).toBe(true);
    expect(submittedOps).toHaveLength(0);
  });

  it("errors clearly for plain places", async () => {
    const { ctx } = makeFakeContext(mixedBlocksTrip);
    const res = await editReservation(ctx, {
      trip_key: "T",
      reservation: "Sensō-ji",
      notes: "x",
    });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain("annotate_place");
  });
});
