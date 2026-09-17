import { describe, expect, it } from "vitest";
import type { AppContext } from "../../src/context.ts";
import { applyOp, type Json0Op } from "../../src/ot/apply.ts";
import {
  addNote,
  addNoteInputSchema,
} from "../../src/tools/add-note.ts";
import type { TripPlan } from "../../src/types.ts";
import { checklistTrip } from "../fixtures/checklist-trip.ts";

function makeFakeContext(trip: TripPlan): {
  ctx: AppContext;
  submittedOps: Json0Op[][];
} {
  const submittedOps: Json0Op[][] = [];
  const entry = { snapshot: structuredClone(trip), version: 1, geos: [] };
  const ctx = {
    userId: 3656632,
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

describe("addNoteInputSchema", () => {
  const base = { trip_key: "T", text: "Remember the tickets" };

  it("accepts zero, one, or both targets", () => {
    expect(addNoteInputSchema.safeParse(base).success).toBe(true);
    expect(addNoteInputSchema.safeParse({ ...base, day: "day 1" }).success).toBe(true);
    expect(addNoteInputSchema.safeParse({ ...base, section: "Notes" }).success).toBe(true);
    expect(
      addNoteInputSchema.safeParse({ ...base, day: "day 1", section: "Notes" }).success,
    ).toBe(true);
  });

  it("rejects empty target strings", () => {
    expect(addNoteInputSchema.safeParse({ ...base, day: "" }).success).toBe(false);
    expect(addNoteInputSchema.safeParse({ ...base, section: "" }).success).toBe(false);
  });
});

describe("addNote section targeting", () => {
  it("defaults to Places to visit when no target is provided", async () => {
    const { ctx, submittedOps } = makeFakeContext(checklistTrip);
    const result = await addNote(ctx, {
      trip_key: "T",
      text: "No target",
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.text).toContain("places to visit");
    expect(submittedOps[0]![0]!.p).toEqual([
      "itinerary",
      "sections",
      1,
      "blocks",
      1,
    ]);
  });

  it("lets section override day when both targets are provided", async () => {
    const { ctx, submittedOps } = makeFakeContext(checklistTrip);
    const result = await addNote(ctx, {
      trip_key: "T",
      text: "Two targets",
      day: "day 1",
      section: "Notes",
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.text).toContain('section "Notes"');
    expect(submittedOps[0]![0]!.p).toEqual([
      "itinerary",
      "sections",
      0,
      "text",
    ]);
  });

  it("adds a note to the textOnly Notes section case-insensitively via rich-text op", async () => {
    const { ctx, submittedOps } = makeFakeContext(checklistTrip);
    const result = await addNote(ctx, {
      trip_key: "T",
      text: "Keep passport copies here",
      section: "notes",
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.text).toContain('section "Notes"');
    expect(submittedOps).toHaveLength(1);
    expect(submittedOps[0]![0]!).toMatchObject({
      p: ["itinerary", "sections", 0, "text"],
      t: "rich-text",
      o: [{ insert: "Keep passport copies here\n" }],
    });
  });

  it("adds a note block to a custom normal section", async () => {
    const trip = structuredClone(checklistTrip);
    trip.itinerary.sections.push({
      id: 999,
      type: "normal",
      mode: "placeList",
      heading: "Trip Preparations",
      date: null,
      blocks: [],
    });
    const { ctx, submittedOps } = makeFakeContext(trip);
    const result = await addNote(ctx, {
      trip_key: "T",
      text: "Buy travel insurance",
      section: "Trip Preparations",
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.text).toContain('section "Trip Preparations"');
    expect(submittedOps).toHaveLength(2);
    expect(submittedOps[0]![0]!.p).toEqual([
      "itinerary",
      "sections",
      trip.itinerary.sections.length - 1,
      "blocks",
      0,
    ]);
    expect((submittedOps[0]![0] as { li: { type: string } }).li.type).toBe("note");
    expect(submittedOps[1]![0]).toMatchObject({
      p: ["itinerary", "sections", trip.itinerary.sections.length - 1, "blocks", 0, "text"],
      t: "rich-text",
      o: [{ insert: "Buy travel insurance\n" }],
    });
  });

  it("adds a note to the textOnly Notes section via day: 'notes'", async () => {
    const { ctx, submittedOps } = makeFakeContext(checklistTrip);
    const result = await addNote(ctx, {
      trip_key: "T",
      text: "Packing reminder",
      day: "notes",
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.text).toContain('section "Notes"');
    expect(submittedOps).toHaveLength(1);
    expect(submittedOps[0]![0]!).toMatchObject({
      p: ["itinerary", "sections", 0, "text"],
      t: "rich-text",
      o: [{ insert: "Packing reminder\n" }],
    });
  });

  it("appends to existing text in the textOnly Notes section", async () => {
    const trip = structuredClone(checklistTrip);
    trip.itinerary.sections[0]!.text = { ops: [{ insert: "First note\n" }] };
    const { ctx, submittedOps } = makeFakeContext(trip);
    const result = await addNote(ctx, {
      trip_key: "T",
      text: "Second note",
      day: "notes",
    });

    expect(result.isError).toBeUndefined();
    expect(submittedOps).toHaveLength(1);
    expect(submittedOps[0]![0]!).toMatchObject({
      p: ["itinerary", "sections", 0, "text"],
      t: "rich-text",
      o: [{ retain: "First note\n".length }, { insert: "Second note\n" }],
    });
  });

  it("adds a note to Places to visit when explicitly targeted", async () => {
    const { ctx, submittedOps } = makeFakeContext(checklistTrip);
    const result = await addNote(ctx, {
      trip_key: "T",
      text: "General trip reminder",
      section: "Places to visit",
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.text).toContain('section "Places to visit"');
    expect(submittedOps[0]![0]!.p).toEqual([
      "itinerary",
      "sections",
      1,
      "blocks",
      1,
    ]);
  });

  it("rejects an unknown section without submitting operations", async () => {
    const { ctx, submittedOps } = makeFakeContext(checklistTrip);
    const result = await addNote(ctx, {
      trip_key: "T",
      text: "Unknown destination",
      section: "Does not exist",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('Section "Does not exist" not found');
    expect(submittedOps).toHaveLength(0);
  });

  it("allows a non-dayPlan section even when it has a date", async () => {
    const trip = structuredClone(checklistTrip);
    trip.itinerary.sections[0]!.date = "2026-06-01";
    const { ctx, submittedOps } = makeFakeContext(trip);
    const result = await addNote(ctx, {
      trip_key: "T",
      text: "Keep this in Notes",
      section: "Notes",
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.text).toContain('section "Notes"');
    expect(submittedOps[0]![0]!.p).toEqual([
      "itinerary",
      "sections",
      0,
      "text",
    ]);
  });

  it("rejects a dayPlan section even when it has no date", async () => {
    const trip = structuredClone(checklistTrip);
    trip.itinerary.sections[2]!.date = null;
    const { ctx, submittedOps } = makeFakeContext(trip);
    const result = await addNote(ctx, {
      trip_key: "T",
      text: "Use the day target instead",
      section: "Arrival day",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("is a dated section");
    expect(result.content[0]!.text).toContain('"day" parameter');
    expect(submittedOps).toHaveLength(0);
  });

  it("preserves day targeting", async () => {
    const { ctx, submittedOps } = makeFakeContext(checklistTrip);
    const result = await addNote(ctx, {
      trip_key: "T",
      text: "Day-level reminder",
      day: "day 1",
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.text).toContain("day 2026-06-01");
    expect(submittedOps[0]![0]!.p).toEqual([
      "itinerary",
      "sections",
      2,
      "blocks",
      3,
    ]);
  });
});
