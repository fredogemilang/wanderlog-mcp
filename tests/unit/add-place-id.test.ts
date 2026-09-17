import { describe, expect, it } from "vitest";
import type { AppContext } from "../../src/context.ts";
import { applyOp, type Json0Op } from "../../src/ot/apply.ts";
import { addPlace } from "../../src/tools/add-place.ts";
import { isPlaceBlock, type TripPlan } from "../../src/types.ts";
import { checklistTrip } from "../fixtures/checklist-trip.ts";

function makeFakeContext(trip: TripPlan, geos: Array<{ id: number; name: string; latitude: number; longitude: number }> = []): {
  ctx: AppContext;
  submittedOps: Json0Op[][];
} {
  const submittedOps: Json0Op[][] = [];
  const entry = { snapshot: structuredClone(trip), version: 1, geos };
  const failIfCalled = async () => {
    throw new Error("searchPlacesAutocomplete should not be called when place_id is given");
  };
  const ctx = {
    userId: 3656632,
    rest: {
      searchPlacesAutocomplete: failIfCalled,
      getPlaceDetails: async (placeId: string) => ({
        name: "The Right Branch",
        place_id: placeId,
      }),
      getPlacePhotos: async () => [],
    },
    pool: {
      get: () => ({
        isSubscribed: true,
        version: 1,
        async submit(ops: Json0Op[]) {
          submittedOps.push(ops);
        },
      }),
    },
    tripCache: {
      getEntry: async () => entry,
      applyLocalOp: (_key: string, ops: Json0Op[], version: number) => {
        entry.snapshot = applyOp(entry.snapshot, ops);
        entry.version = version;
      },
      invalidate: () => {},
    },
  } as unknown as AppContext;
  return { ctx, submittedOps };
}

describe("addPlace with place_id", () => {
  it("rejects when neither place nor place_id is provided", async () => {
    const { ctx, submittedOps } = makeFakeContext(checklistTrip);
    const result = await addPlace(ctx, { trip_key: "T" });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("At least one of place or place_id must be provided");
    expect(submittedOps).toHaveLength(0);
  });

  it("adds the exact candidate by place_id, skipping the autocomplete search", async () => {
    const { ctx, submittedOps } = makeFakeContext(checklistTrip);
    const result = await addPlace(ctx, {
      trip_key: "T",
      place_id: "ChIJcorrectbranch",
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.text).toContain("The Right Branch");
    expect(submittedOps).toHaveLength(1);
    const inserted = submittedOps[0]![0] as { li: { place: { place_id: string } } };
    expect(inserted.li.place.place_id).toBe("ChIJcorrectbranch");
  });

  it("resolves by place_id even when the trip has no location anchor", async () => {
    const bareTrip = {
      title: "Bare trip",
      itinerary: {
        sections: [
          {
            id: 1,
            type: "normal",
            mode: "placeList",
            heading: "Places to visit",
            date: null,
            blocks: [],
          },
        ],
      },
    } as unknown as TripPlan;
    const { ctx, submittedOps } = makeFakeContext(bareTrip, []);

    const result = await addPlace(ctx, {
      trip_key: "T",
      place_id: "ChIJnogeoanchor",
    });

    expect(result.isError).toBeUndefined();
    expect(submittedOps).toHaveLength(1);
  });

  it("prefers place_id over place when both are given", async () => {
    const { ctx, submittedOps } = makeFakeContext(checklistTrip);
    const result = await addPlace(ctx, {
      trip_key: "T",
      place: "this free-text query would hit the network if used",
      place_id: "ChIJexplicit",
    });

    expect(result.isError).toBeUndefined();
    const trip = applyOp(checklistTrip, submittedOps[0]!);
    const found = trip.itinerary.sections
      .flatMap((s) => s.blocks)
      .find((b) => isPlaceBlock(b) && b.place.place_id === "ChIJexplicit");
    expect(found).toBeDefined();
  });
});
