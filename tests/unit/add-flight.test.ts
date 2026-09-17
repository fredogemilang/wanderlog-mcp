import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { AppContext } from "../../src/context.ts";
import { WanderlogError } from "../../src/errors.ts";
import { applyOp, type Json0Op } from "../../src/ot/apply.ts";
import {
  addFlight,
  addFlightDescription,
  addFlightInputSchema,
} from "../../src/tools/add-flight.ts";
import {
  buildAirportEndpoint,
  buildFlightBlock,
  sectionInsertOp,
} from "../../src/tools/shared.ts";
import type { AirportEndpoint, PlaceData, TripPlan } from "../../src/types.ts";

const place = (name: string): PlaceData => ({
  name,
  place_id: `pid_${name}`,
  geometry: { location: { lat: -6.1275, lng: 106.6537 } },
});

const makeAirportEndpoint = (
  name: string,
  iata: string,
  date: string,
  time: string,
): AirportEndpoint => ({
  date,
  time,
  airport: { name, iata },
});

const baseTrip = (): TripPlan =>
  ({
    id: 12345,
    key: "flighttripkey",
    title: "Trip to Shanghai",
    userId: 42,
    itinerary: {
      sections: [
        {
          id: 1,
          type: "normal",
          mode: "placeList",
          heading: "Places to visit",
          date: null,
          blocks: [
            {
              id: 10,
              type: "place",
              place: {
                name: "The Bund",
                place_id: "pid_the_bund",
                geometry: { location: { lat: 31.24, lng: 121.49 } },
              },
            },
          ],
        },
      ],
    },
  }) as unknown as TripPlan;

function makeFakeContext(
  trip: TripPlan,
  options: {
    userId?: number | null;
    autocompleteResults?: Record<string, Array<{ place_id: string }>>;
    places?: Record<string, PlaceData>;
    failSubmit?: boolean;
    hasGeoAnchor?: boolean;
  } = {},
): { ctx: AppContext; submittedOps: Json0Op[][] } {
  const submittedOps: Json0Op[][] = [];
  const entry = {
    snapshot: structuredClone(trip),
    version: 1,
    geos: options.hasGeoAnchor !== false ? [{ latitude: -6.1275, longitude: 106.6537 }] : [],
  };
  if (options.hasGeoAnchor === false) {
    // strip geometry from all places
    for (const section of entry.snapshot.itinerary.sections) {
      for (const block of section.blocks) {
        if ("place" in block && (block as { place?: PlaceData }).place) {
          delete (block as { place: PlaceData }).place.geometry;
        }
      }
    }
  }

  const ctx = {
    userId: options.userId !== undefined ? options.userId : 42,
    pool: {
      get: () => ({
        isSubscribed: true,
        version: 1,
        async submit(ops: Json0Op[]) {
          if (options.failSubmit) {
            throw new WanderlogError("ShareDB rejected op", "ws_op_rejected");
          }
          submittedOps.push(ops);
        },
      }),
    },
    tripCache: {
      getEntry: async () => entry,
      get: async () => entry.snapshot,
      applyLocalOp: (_key: string, ops: Json0Op[], version: number) => {
        entry.snapshot = applyOp(entry.snapshot, ops);
        entry.version = version;
      },
      invalidate: () => {},
    },
    rest: {
      searchPlacesAutocomplete: async (req: { input: string }) => {
        if (options.autocompleteResults && req.input in options.autocompleteResults) {
          return options.autocompleteResults[req.input]!;
        }
        return [{ place_id: `pid_${req.input}` }];
      },
      getPlaceDetails: async (placeId: string) => {
        if (options.places && placeId in options.places) {
          return options.places[placeId]!;
        }
        return place(placeId.replace(/^pid_/, ""));
      },
    },
  } as unknown as AppContext;

  return { ctx, submittedOps };
}

describe("addFlightInputSchema", () => {
  const schema = z.object(addFlightInputSchema);

  const validInput = {
    trip_key: "trip123",
    airline: "China Eastern Airlines",
    flight_number: "5070",
    from_airport: "CGK",
    to_airport: "PVG",
    depart_date: "2026-11-08",
    depart_time: "09:00",
    arrive_date: "2026-11-08",
    arrive_time: "15:00",
  };

  it("accepts valid input with all required fields", () => {
    const res = schema.safeParse(validInput);
    expect(res.success).toBe(true);
  });

  it("accepts flight_number as number", () => {
    const res = schema.safeParse({ ...validInput, flight_number: 5070 });
    expect(res.success).toBe(true);
  });

  it("accepts optional fields", () => {
    const res = schema.safeParse({
      ...validInput,
      confirmation_number: "CONF123",
      notes: "Seat 14A",
      traveler_names: ["Alice", "Bob"],
    });
    expect(res.success).toBe(true);
  });

  it("rejects missing required fields", () => {
    expect(schema.safeParse({ ...validInput, trip_key: undefined }).success).toBe(false);
    expect(schema.safeParse({ ...validInput, airline: undefined }).success).toBe(false);
    expect(schema.safeParse({ ...validInput, flight_number: undefined }).success).toBe(false);
    expect(schema.safeParse({ ...validInput, from_airport: undefined }).success).toBe(false);
    expect(schema.safeParse({ ...validInput, to_airport: undefined }).success).toBe(false);
    expect(schema.safeParse({ ...validInput, depart_date: undefined }).success).toBe(false);
    expect(schema.safeParse({ ...validInput, depart_time: undefined }).success).toBe(false);
    expect(schema.safeParse({ ...validInput, arrive_date: undefined }).success).toBe(false);
    expect(schema.safeParse({ ...validInput, arrive_time: undefined }).success).toBe(false);
  });

  it("rejects empty strings for required fields", () => {
    expect(schema.safeParse({ ...validInput, trip_key: "" }).success).toBe(false);
    expect(schema.safeParse({ ...validInput, airline: "" }).success).toBe(false);
    expect(schema.safeParse({ ...validInput, flight_number: "" }).success).toBe(false);
    expect(schema.safeParse({ ...validInput, from_airport: "" }).success).toBe(false);
    expect(schema.safeParse({ ...validInput, to_airport: "" }).success).toBe(false);
  });

  it("rejects malformed date and time", () => {
    expect(schema.safeParse({ ...validInput, depart_date: "2026/11/08" }).success).toBe(false);
    expect(schema.safeParse({ ...validInput, depart_time: "9:00" }).success).toBe(false);
    expect(schema.safeParse({ ...validInput, arrive_time: "24:00" }).success).toBe(false);
    expect(schema.safeParse({ ...validInput, arrive_time: "12:60" }).success).toBe(false);
  });
});

describe("addFlightDescription", () => {
  it("contains descriptive text mentioning flights and confirmation", () => {
    expect(addFlightDescription).toContain("flight booking");
    expect(addFlightDescription).toContain("Flights");
  });
});

describe("buildFlightBlock", () => {
  const depart = makeAirportEndpoint("Soekarno-Hatta", "CGK", "2026-11-08", "09:00");
  const arrive = makeAirportEndpoint("Pudong", "PVG", "2026-11-08", "15:00");

  it("builds a flight block with IATA airline code and string flight number", () => {
    const block = buildFlightBlock(42, {
      airline: "MU",
      flight_number: "5070",
      depart,
      arrive,
      confirmation_number: "ABC123",
      notes: "Seat 12A",
      traveler_names: ["John Doe"],
    }) as Record<string, unknown>;

    expect(block.type).toBe("flight");
    expect(block.addedBy).toEqual({ type: "user", userId: 42 });
    expect(block.attachments).toEqual([]);
    expect(block.text).toEqual({ ops: [{ insert: "Seat 12A\n" }] });
    expect(block.confirmationNumber).toBe("ABC123");
    expect(block.travelerNames).toEqual(["John Doe"]);
    expect(block.flightInfo).toEqual({
      airline: { iata: "MU" },
      number: "5070",
    });
    expect(block.depart).toEqual(depart);
    expect(block.arrive).toEqual(arrive);
  });

  it("builds a flight block with airline name and numeric flight number", () => {
    const block = buildFlightBlock(42, {
      airline: "China Eastern Airlines",
      flight_number: 5070,
      depart,
      arrive,
    }) as Record<string, unknown>;

    expect(block.flightInfo).toEqual({
      airline: { name: "China Eastern Airlines" },
      number: 5070,
    });
    expect(block.text).toEqual({ ops: [{ insert: "\n" }] });
    expect("confirmationNumber" in block).toBe(false);
    expect("travelerNames" in block).toBe(false);
  });

  it("supports flightInfo passed directly as an object", () => {
    const block = buildFlightBlock(42, {
      flightInfo: {
        airline: { iata: "MU", name: "China Eastern" },
        number: "MU5070",
      },
      depart,
      arrive,
    }) as Record<string, unknown>;

    expect(block.flightInfo).toEqual({
      airline: { iata: "MU", name: "China Eastern" },
      number: "MU5070",
    });
  });

  it("omits travelerNames when empty array", () => {
    const block = buildFlightBlock(42, {
      airline: "MU",
      flight_number: 5070,
      depart,
      arrive,
      traveler_names: [],
    }) as Record<string, unknown>;

    expect("travelerNames" in block).toBe(false);
  });
});

describe("buildAirportEndpoint", () => {
  it("extracts 3-letter IATA code from query", () => {
    const p = place("Soekarno-Hatta International Airport");
    const ep = buildAirportEndpoint("CGK", p, "2026-11-08", "09:00");
    expect(ep.airport?.iata).toBe("CGK");
    expect(ep.airport?.name).toBe("Soekarno-Hatta International Airport");
    expect(ep.date).toBe("2026-11-08");
    expect(ep.time).toBe("09:00");
  });

  it("extracts IATA code from parentheses in place name", () => {
    const p = place("Soekarno-Hatta International Airport (CGK)");
    const ep = buildAirportEndpoint("Jakarta Airport", p, "2026-11-08", "09:00");
    expect(ep.airport?.iata).toBe("CGK");
    expect(ep.airport?.name).toBe("Soekarno-Hatta International Airport");
  });

  it("extracts IATA code from parentheses in query if not in place name", () => {
    const p = place("Soekarno-Hatta International Airport");
    const ep = buildAirportEndpoint("Jakarta (CGK)", p, "2026-11-08", "09:00");
    expect(ep.airport?.iata).toBe("CGK");
    expect(ep.airport?.name).toBe("Soekarno-Hatta International Airport");
  });

  it("leaves iata undefined when no code is detectable", () => {
    const p = place("Some Remote Airstrip");
    const ep = buildAirportEndpoint("Some Remote Airstrip", p, "2026-11-08", "09:00");
    expect(ep.airport?.iata).toBeUndefined();
    expect(ep.airport?.name).toBe("Some Remote Airstrip");
  });
});

describe("sectionInsertOp with flights", () => {
  it("creates a new flights section when none exists", () => {
    const trip = baseTrip();
    const depart = makeAirportEndpoint("A", "AAA", "2026-11-08", "09:00");
    const arrive = makeAirportEndpoint("B", "BBB", "2026-11-08", "15:00");
    const block = buildFlightBlock(42, { airline: "MU", flight_number: 5070, depart, arrive });

    const op = sectionInsertOp(trip, "flights", block);
    expect(op.p).toEqual(["itinerary", "sections", 1]);
    const next = applyOp(trip, [op]);

    const flightsSec = next.itinerary.sections.find((s) => s.type === "flights")!;
    expect(flightsSec).toBeDefined();
    expect(flightsSec.heading).toBe("Flights");
    expect(flightsSec.placeMarkerIcon).toBe("plane");
    expect(flightsSec.placeMarkerColor).toBe("#4a90e2");
    expect(flightsSec.blocks).toHaveLength(1);
    expect(flightsSec.blocks[0]!.type).toBe("flight");
  });

  it("appends to an existing flights section", () => {
    const trip = baseTrip();
    trip.itinerary.sections.push({
      id: 99,
      type: "flights",
      mode: "placeList",
      heading: "Flights",
      date: null,
      blocks: [{ id: 100, type: "flight" }],
    } as never);

    const depart = makeAirportEndpoint("A", "AAA", "2026-11-08", "09:00");
    const arrive = makeAirportEndpoint("B", "BBB", "2026-11-08", "15:00");
    const block = buildFlightBlock(42, { airline: "MU", flight_number: 5070, depart, arrive });

    const op = sectionInsertOp(trip, "flights", block);
    expect(op.p).toEqual(["itinerary", "sections", 1, "blocks", 1]);
    const next = applyOp(trip, [op]);

    const flightsSec = next.itinerary.sections.find((s) => s.type === "flights")!;
    expect(flightsSec.blocks).toHaveLength(2);
  });
});

describe("addFlight tool execution", () => {
  it("adds a flight and returns confirmation message", async () => {
    const trip = baseTrip();
    const { ctx, submittedOps } = makeFakeContext(trip, {
      places: {
        pid_CGK: place("Soekarno-Hatta International Airport"),
        pid_PVG: place("Shanghai Pudong International Airport"),
      },
    });

    const res = await addFlight(ctx, {
      trip_key: "flighttripkey",
      airline: "China Eastern Airlines",
      flight_number: "5070",
      from_airport: "CGK",
      to_airport: "PVG",
      depart_date: "2026-11-08",
      depart_time: "09:00",
      arrive_date: "2026-11-08",
      arrive_time: "15:00",
      confirmation_number: "MU12345",
      notes: "Terminal 3",
      traveler_names: ["Bob"],
    });

    expect(res.isError).toBeUndefined();
    expect(res.content[0]!.text).toContain(
      'Added flight China Eastern Airlines 5070 to "Trip to Shanghai" · Soekarno-Hatta International Airport → Shanghai Pudong International Airport · 2026-11-08 09:00.',
    );

    expect(submittedOps).toHaveLength(1);
    const op = submittedOps[0]![0]!;
    expect(op.p).toEqual(["itinerary", "sections", 1]);
    const newSection = op.li as { type: string; blocks: Array<Record<string, unknown>> };
    expect(newSection.type).toBe("flights");
    expect(newSection.blocks).toHaveLength(1);

    const flightBlock = newSection.blocks[0]!;
    expect(flightBlock.type).toBe("flight");
    expect(flightBlock.confirmationNumber).toBe("MU12345");
    expect(flightBlock.travelerNames).toEqual(["Bob"]);
    expect(flightBlock.text).toEqual({ ops: [{ insert: "Terminal 3\n" }] });
  });

  it("avoids repeating airline prefix when flight_number starts with airline code", async () => {
    const trip = baseTrip();
    const { ctx } = makeFakeContext(trip);

    const res = await addFlight(ctx, {
      trip_key: "flighttripkey",
      airline: "MU",
      flight_number: "MU5070",
      from_airport: "CGK",
      to_airport: "PVG",
      depart_date: "2026-11-08",
      depart_time: "09:00",
      arrive_date: "2026-11-08",
      arrive_time: "15:00",
    });

    expect(res.isError).toBeUndefined();
    expect(res.content[0]!.text).toContain("Added flight MU5070 to");
  });

  it("accepts an overnight flight", async () => {
    const trip = baseTrip();
    const { ctx, submittedOps } = makeFakeContext(trip);

    const res = await addFlight(ctx, {
      trip_key: "flighttripkey",
      airline: "MU",
      flight_number: 5070,
      from_airport: "CGK",
      to_airport: "PVG",
      depart_date: "2026-11-08",
      depart_time: "22:00",
      arrive_date: "2026-11-09",
      arrive_time: "06:00",
    });

    expect(res.isError).toBeUndefined();
    expect(submittedOps).toHaveLength(1);
  });
});

describe("addFlight validation and error handling", () => {
  it("rejects arrive before depart on the same day", async () => {
    const trip = baseTrip();
    const { ctx, submittedOps } = makeFakeContext(trip);

    const res = await addFlight(ctx, {
      trip_key: "flighttripkey",
      airline: "MU",
      flight_number: "5070",
      from_airport: "CGK",
      to_airport: "PVG",
      depart_date: "2026-11-08",
      depart_time: "15:00",
      arrive_date: "2026-11-08",
      arrive_time: "09:00",
    });

    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain("must be on or after depart");
    expect(submittedOps).toHaveLength(0);
  });

  it("returns error when auth is missing (userId is null)", async () => {
    const trip = baseTrip();
    const { ctx, submittedOps } = makeFakeContext(trip, { userId: null });

    const res = await addFlight(ctx, {
      trip_key: "flighttripkey",
      airline: "MU",
      flight_number: "5070",
      from_airport: "CGK",
      to_airport: "PVG",
      depart_date: "2026-11-08",
      depart_time: "09:00",
      arrive_date: "2026-11-08",
      arrive_time: "15:00",
    });

    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain("User ID not available");
    expect(submittedOps).toHaveLength(0);
  });

  it("returns error when airport place resolution returns no predictions", async () => {
    const trip = baseTrip();
    const { ctx, submittedOps } = makeFakeContext(trip, {
      autocompleteResults: {
        UNKNOWN_AIRPORT: [],
      },
    });

    const res = await addFlight(ctx, {
      trip_key: "flighttripkey",
      airline: "MU",
      flight_number: "5070",
      from_airport: "UNKNOWN_AIRPORT",
      to_airport: "PVG",
      depart_date: "2026-11-08",
      depart_time: "09:00",
      arrive_date: "2026-11-08",
      arrive_time: "15:00",
    });

    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain("No place found matching");
    expect(submittedOps).toHaveLength(0);
  });

  it("returns error when trip has no location anchor", async () => {
    const trip = baseTrip();
    const { ctx, submittedOps } = makeFakeContext(trip, { hasGeoAnchor: false });

    const res = await addFlight(ctx, {
      trip_key: "flighttripkey",
      airline: "MU",
      flight_number: "5070",
      from_airport: "CGK",
      to_airport: "PVG",
      depart_date: "2026-11-08",
      depart_time: "09:00",
      arrive_date: "2026-11-08",
      arrive_time: "15:00",
    });

    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain("location anchor is available");
    expect(submittedOps).toHaveLength(0);
  });

  it("returns error when submit fails", async () => {
    const trip = baseTrip();
    const { ctx } = makeFakeContext(trip, { failSubmit: true });

    const res = await addFlight(ctx, {
      trip_key: "flighttripkey",
      airline: "MU",
      flight_number: "5070",
      from_airport: "CGK",
      to_airport: "PVG",
      depart_date: "2026-11-08",
      depart_time: "09:00",
      arrive_date: "2026-11-08",
      arrive_time: "15:00",
    });

    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain("ShareDB rejected op");
  });
});
