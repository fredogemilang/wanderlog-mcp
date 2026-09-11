import { describe, expect, it } from "vitest";
import type { CacheEntry } from "../../src/cache/trip-cache.ts";
import type { AppContext } from "../../src/context.ts";
import { applyOp, type Json0Op } from "../../src/ot/apply.ts";
import {
  moveBlock,
  moveBlockInputSchema,
} from "../../src/tools/move-block.ts";
import type { Block, TripPlan } from "../../src/types.ts";

function place(id: number, name: string): Block {
  return {
    id,
    type: "place",
    place: {
      name,
      place_id: `ChIJ_${id}`,
      photo_urls: [`https://example.com/${id}.jpg`],
    },
    text: { ops: [{ insert: `Notes for ${name}\n` }] },
    startTime: "09:00",
    endTime: "10:00",
    imageKeys: [`image-${id}`],
  };
}

function fixture(): TripPlan {
  return {
    id: 1,
    key: "trip",
    title: "Move test",
    userId: 1,
    privacy: "private",
    startDate: "2026-08-01",
    endDate: "2026-08-01",
    days: 1,
    placeCount: 4,
    schemaVersion: 2,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    contributors: [],
    itinerary: {
      sections: [
        {
          id: 10,
          type: "hotels",
          mode: "placeList",
          heading: "Hotels and lodging",
          date: null,
          blocks: [
            {
              ...place(50, "Test Hotel"),
              hotel: {
                checkIn: "2026-08-01",
                checkOut: "2026-08-02",
                travelerNames: ["Traveler"],
                confirmationNumber: "HOTEL-123",
              },
            },
          ],
        },
        {
          id: 20,
          type: "normal",
          mode: "dayPlan",
          heading: "Day in town",
          date: "2026-08-01",
          blocks: [
            place(101, "Alpha Museum"),
            {
              id: 102,
              type: "note",
              text: { ops: [{ insert: "Walk five minutes.\n" }] },
            },
            place(103, "Bravo Cafe"),
            place(104, "Charlie Park"),
          ],
        },
      ],
    },
  };
}

function makeFakeContext(
  trip: TripPlan,
  options: { applyLocally?: boolean } = {},
): {
  ctx: AppContext;
  submittedOps: Json0Op[][];
  currentTrip: () => TripPlan;
  invalidations: () => number;
} {
  const entry: CacheEntry = {
    snapshot: structuredClone(trip),
    version: 1,
    geos: [],
  };
  let invalidationCount = 0;
  const submittedOps: Json0Op[][] = [];
  const client = {
    isSubscribed: true,
    version: 1,
    async submit(ops: Json0Op[]) {
      submittedOps.push(ops);
      this.version += 1;
    },
  };
  const ctx = {
    pool: { get: () => client },
    tripCache: {
      getEntry: async () => entry,
      applyLocalOp: (_tripKey: string, ops: Json0Op[]) => {
        if (options.applyLocally !== false) {
          entry.snapshot = applyOp(entry.snapshot, ops);
        }
      },
      invalidate: () => {
        invalidationCount += 1;
      },
    },
  } as unknown as AppContext;
  return {
    ctx,
    submittedOps,
    currentTrip: () => entry.snapshot,
    invalidations: () => invalidationCount,
  };
}

function dayIds(trip: TripPlan): number[] {
  return trip.itinerary.sections[1]!.blocks.map((block) => block.id);
}

describe("moveBlockInputSchema", () => {
  const base = { trip_key: "trip", block: "Alpha Museum" };

  it("accepts each destination form", () => {
    expect(
      moveBlockInputSchema.safeParse({ ...base, position: 2 }).success,
    ).toBe(true);
    expect(
      moveBlockInputSchema.safeParse({ ...base, before: "Bravo Cafe" }).success,
    ).toBe(true);
    expect(
      moveBlockInputSchema.safeParse({ ...base, after: "Bravo Cafe" }).success,
    ).toBe(true);
  });

  it("requires exactly one valid destination", () => {
    expect(moveBlockInputSchema.safeParse(base).success).toBe(false);
    expect(
      moveBlockInputSchema.safeParse({
        ...base,
        position: 2,
        before: "Bravo Cafe",
      }).success,
    ).toBe(false);
    expect(
      moveBlockInputSchema.safeParse({ ...base, position: 0 }).success,
    ).toBe(false);
    expect(
      moveBlockInputSchema.safeParse({ ...base, position: 1.5 }).success,
    ).toBe(false);
  });
});

describe("moveBlock absolute positions", () => {
  it("counts notes in the complete displayed block order", async () => {
    const fake = makeFakeContext(fixture());
    const original = structuredClone(
      fake.currentTrip().itinerary.sections[1]!.blocks[2],
    );

    const result = await moveBlock(fake.ctx, {
      trip_key: "trip",
      block: "Bravo Cafe",
      position: 1,
    });

    expect(result.isError).toBeUndefined();
    expect(fake.submittedOps).toEqual([
      [
        {
          p: ["itinerary", "sections", 1, "blocks", 2],
          lm: 0,
        },
      ],
    ]);
    expect(dayIds(fake.currentTrip())).toEqual([103, 101, 102, 104]);
    expect(fake.currentTrip().itinerary.sections[1]!.blocks[0]).toEqual(
      original,
    );
  });

  it("moves a block forward to the final position", async () => {
    const fake = makeFakeContext(fixture());

    const result = await moveBlock(fake.ctx, {
      trip_key: "trip",
      block: "Alpha Museum",
      position: 4,
    });

    expect(result.isError).toBeUndefined();
    expect(fake.submittedOps[0]![0]).toMatchObject({
      p: ["itinerary", "sections", 1, "blocks", 0],
      lm: 3,
    });
    expect(dayIds(fake.currentTrip())).toEqual([102, 103, 104, 101]);
  });

  it("returns a non-mutating success when already at the requested position", async () => {
    const fake = makeFakeContext(fixture());

    const result = await moveBlock(fake.ctx, {
      trip_key: "trip",
      block: "Bravo Cafe",
      position: 3,
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.text).toContain("No changes made");
    expect(fake.submittedOps).toHaveLength(0);
    expect(dayIds(fake.currentTrip())).toEqual([101, 102, 103, 104]);
  });

  it("rejects a position beyond the section length", async () => {
    const fake = makeFakeContext(fixture());

    const result = await moveBlock(fake.ctx, {
      trip_key: "trip",
      block: "Alpha Museum",
      position: 5,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("has 4 blocks");
    expect(fake.submittedOps).toHaveLength(0);
  });
});

describe("moveBlock relative index calculations", () => {
  const cases = [
    {
      name: "moves before a target after the source",
      block: "Alpha Museum",
      destination: { before: "Charlie Park" },
      op: { source: 0, destination: 2 },
      ids: [102, 103, 101, 104],
    },
    {
      name: "moves after a target after the source",
      block: "Alpha Museum",
      destination: { after: "Charlie Park" },
      op: { source: 0, destination: 3 },
      ids: [102, 103, 104, 101],
    },
    {
      name: "moves before a target before the source",
      block: "Charlie Park",
      destination: { before: "Alpha Museum" },
      op: { source: 3, destination: 0 },
      ids: [104, 101, 102, 103],
    },
    {
      name: "moves after a target before the source",
      block: "Charlie Park",
      destination: { after: "Alpha Museum" },
      op: { source: 3, destination: 1 },
      ids: [101, 104, 102, 103],
    },
  ] as const;

  for (const testCase of cases) {
    it(testCase.name, async () => {
      const fake = makeFakeContext(fixture());

      const result = await moveBlock(fake.ctx, {
        trip_key: "trip",
        block: testCase.block,
        ...testCase.destination,
      });

      expect(result.isError).toBeUndefined();
      expect(fake.submittedOps[0]![0]).toMatchObject({
        p: [
          "itinerary",
          "sections",
          1,
          "blocks",
          testCase.op.source,
        ],
        lm: testCase.op.destination,
      });
      expect(dayIds(fake.currentTrip())).toEqual(testCase.ids);
    });
  }

  it("skips an already-satisfied before move", async () => {
    const fake = makeFakeContext(fixture());

    const result = await moveBlock(fake.ctx, {
      trip_key: "trip",
      block: "Bravo Cafe",
      before: "Charlie Park",
    });

    expect(result.isError).toBeUndefined();
    expect(fake.submittedOps).toHaveLength(0);
  });

  it("skips an already-satisfied after move", async () => {
    const fake = makeFakeContext(fixture());

    const result = await moveBlock(fake.ctx, {
      trip_key: "trip",
      block: "Charlie Park",
      after: "Bravo Cafe",
    });

    expect(result.isError).toBeUndefined();
    expect(fake.submittedOps).toHaveLength(0);
  });
});

describe("moveBlock reference and safety errors", () => {
  it("rejects missing source references without submitting", async () => {
    const fake = makeFakeContext(fixture());

    const result = await moveBlock(fake.ctx, {
      trip_key: "trip",
      block: "Missing Museum",
      position: 1,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("No itinerary block matching");
    expect(fake.submittedOps).toHaveLength(0);
  });

  it("returns candidates for an ambiguous source", async () => {
    const trip = fixture();
    trip.itinerary.sections[1]!.blocks.push(place(105, "Alpha Museum"));
    const fake = makeFakeContext(trip);

    const result = await moveBlock(fake.ctx, {
      trip_key: "trip",
      block: "Alpha Museum",
      position: 1,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("is ambiguous");
    expect(result.content[0]!.text).toContain("1st Alpha Museum");
    expect(fake.submittedOps).toHaveLength(0);
  });

  it("returns candidates for an ambiguous relative target", async () => {
    const trip = fixture();
    trip.itinerary.sections[1]!.blocks.push(place(105, "Bravo Cafe"));
    const fake = makeFakeContext(trip);

    const result = await moveBlock(fake.ctx, {
      trip_key: "trip",
      block: "Alpha Museum",
      before: "Bravo Cafe",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("before target");
    expect(result.content[0]!.text).toContain("is ambiguous");
    expect(fake.submittedOps).toHaveLength(0);
  });

  it("rejects a role-keyword target in another section", async () => {
    const fake = makeFakeContext(fixture());

    const result = await moveBlock(fake.ctx, {
      trip_key: "trip",
      block: "Alpha Museum",
      before: "the hotel",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("different sections");
    expect(fake.submittedOps).toHaveLength(0);
  });

  it("rejects moving a block relative to itself", async () => {
    const fake = makeFakeContext(fixture());

    const result = await moveBlock(fake.ctx, {
      trip_key: "trip",
      block: "Alpha Museum",
      before: "Alpha Museum",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("before itself");
    expect(fake.submittedOps).toHaveLength(0);
  });

  it("invalidates the cache when post-apply verification fails", async () => {
    const fake = makeFakeContext(fixture(), { applyLocally: false });

    const result = await moveBlock(fake.ctx, {
      trip_key: "trip",
      block: "Alpha Museum",
      position: 4,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("may have been applied");
    expect(fake.submittedOps).toHaveLength(1);
    expect(fake.invalidations()).toBe(1);
  });
});
