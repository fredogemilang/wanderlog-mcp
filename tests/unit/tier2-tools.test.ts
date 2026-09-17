import { describe, expect, it, vi } from "vitest";
import type { AppContext } from "../../src/context.ts";
import { applyOp, type Json0Op } from "../../src/ot/apply.ts";
import { addExpense } from "../../src/tools/add-expense.ts";
import {
  buildReservationText,
  addRestaurantReservation,
  findRestaurantSection,
} from "../../src/tools/add-restaurant-reservation.ts";
import { budgetSummary, resolveSplitWith, setBudget, summariseBudget } from "../../src/tools/budget.ts";
import {
  findCollaborator,
  inviteCollaborator,
  listCollaborators,
  removeCollaborator,
} from "../../src/tools/collaborators.ts";
import { editExpense } from "../../src/tools/edit-expense.ts";
import { explore, matchCategory } from "../../src/tools/explore.ts";
import { getTravelTimes, legKey } from "../../src/tools/get-travel-times.ts";
import { updateTrip } from "../../src/tools/update-trip.ts";
import type { ExplorePage, TripPlan } from "../../src/types.ts";
import { budgetTrip } from "../fixtures/budget-trip.ts";
import { checklistTrip } from "../fixtures/checklist-trip.ts";
import { queenstownTrip } from "../fixtures/queenstown-trip.ts";

const ME = 3656632;
const FRIEND = { id: 777001, username: "sam_travels", name: "Sam Lee" };

function withFriend(trip: TripPlan): TripPlan {
  const t = structuredClone(trip);
  t.userId = ME;
  t.contributors = [{ id: ME, username: "ali1253", name: "Ali" }, FRIEND];
  t.editors = t.contributors;
  return t;
}

function makeFakeContext(trip: TripPlan, rest: Record<string, unknown> = {}) {
  const submittedOps: Json0Op[][] = [];
  const entry = {
    snapshot: structuredClone(trip),
    version: 1,
    geos: [{ id: 2, name: "Kyoto", latitude: 35.01, longitude: 135.77 }],
  };
  const invalidate = vi.fn();
  const ctx = {
    userId: ME,
    rest,
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
      invalidate,
    },
  } as unknown as AppContext;
  return { ctx, submittedOps, entry, invalidate };
}

// ---------------------------------------------------------------------------
// explore
// ---------------------------------------------------------------------------

const explorePage: ExplorePage = {
  geo: { id: 2, name: "Kyoto", countryName: "Japan" },
  categories: [
    { id: 86, name: "Restaurants", shortName: "Restaurants" },
    { id: 104389, name: "Attractions", shortName: "Attractions" },
    { id: 91, name: "Cafes", shortName: "Cafes" },
    { id: 120, name: "Kid-friendly attractions", shortName: "Kid-friendly attractions" },
  ],
  searchedCategories: [{ id: 1524706, name: "Temples" }],
  placesLists: [
    { id: "104389", type: "geoCategory", title: "Best attractions in Kyoto", placeCount: 49 },
    { id: "abc", type: "tripPlan", title: "First timer | Kyoto 7 days", placeCount: 49 },
  ],
  sections: [
    {
      type: "attractions",
      places: {
        heading: "Top places to visit",
        blocks: [
          { type: "place", place: { name: "Fushimi Inari Taisha", placeId: "ChIJ_inari" } },
          { type: "place", place: { name: "Kinkaku-ji", placeId: "ChIJ_kinkaku" } },
        ],
      },
    },
  ],
};

describe("explore", () => {
  it("matches categories by alias, exact name, and substring", () => {
    expect(matchCategory(explorePage, "coffee").map((c) => c.id)).toEqual([91]);
    expect(matchCategory(explorePage, "things to do").map((c) => c.id)).toEqual([104389]);
    expect(matchCategory(explorePage, "temple").map((c) => c.id)).toEqual([1524706]);
    expect(matchCategory(explorePage, "kids").map((c) => c.id)).toEqual([120]);
    expect(matchCategory(explorePage, "zzz")).toEqual([]);
  });

  it("overview lists top places, categories, and marks places already in the trip", async () => {
    const trip = structuredClone(queenstownTrip);
    (trip.itinerary.sections[1]!.blocks[0] as { place: { place_id: string } }).place.place_id = "ChIJ_inari";
    const getExplorePage = vi.fn(async () => explorePage);
    const { ctx } = makeFakeContext(trip, { getExplorePage });
    const res = await explore(ctx, { trip_key: "T" });
    expect(res.isError).toBeUndefined();
    expect(getExplorePage).toHaveBeenCalledWith(2, "T");
    expect(res.content[0]!.text).toContain("Fushimi Inari Taisha ✔ in trip");
    expect(res.content[0]!.text).toContain("Categories");
    expect(res.content[0]!.text).toContain("Cafes");
  });

  it("category mode fetches the geoCategory list and formats entries", async () => {
    const getPlacesList = vi.fn(async () => ({
      id: "91",
      type: "geoCategory",
      title: "The 50 best cafes in Kyoto",
      placeMetadata: [
        {
          name: "Weekenders Coffee",
          placeId: "ChIJ_week",
          rating: 4.5,
          numRatings: 1200,
          categories: ["Coffee shop"],
          generatedDescription: "A tiny standing-room espresso bar hidden in a parking lot.",
          minMinutesSpent: 30,
          maxMinutesSpent: 45,
          address: "Nakagyo Ward, Kyoto",
          priceLevel: 2,
          sources: [{ siteName: "Time Out", snippet: "…" }],
        },
        { name: "Closed Cafe", placeId: "ChIJ_closed", permanentlyClosed: true },
      ],
    }));
    const { ctx } = makeFakeContext(queenstownTrip, {
      getExplorePage: async () => explorePage,
      getPlacesList,
    });
    const res = await explore(ctx, { trip_key: "T", category: "cafes", response_format: "detailed" });
    expect(res.isError).toBeUndefined();
    expect(getPlacesList).toHaveBeenCalledWith("geoCategory", 91, 2);
    const text = res.content[0]!.text;
    expect(text).toContain("1. Weekenders Coffee ★4.5 (1,200) · Coffee shop");
    expect(text).toContain("typical visit 30m–45m · $$");
    expect(text).toContain("place_id: ChIJ_week");
    expect(text).not.toContain("Closed Cafe");
  });

  it("unknown category returns the available list as an error hint", async () => {
    const { ctx } = makeFakeContext(queenstownTrip, { getExplorePage: async () => explorePage });
    const res = await explore(ctx, { trip_key: "T", category: "scuba" });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain("Available: Restaurants, Attractions");
  });

  it("near mode uses recommendations/v2 excluding places already in the trip", async () => {
    const getRecommendationsNear = vi.fn(async () => [
      { id: 1, placeId: "ChIJ_a", name: "Komyo-in Temple", latitude: -45.0312, longitude: 168.6626 },
    ]);
    const { ctx } = makeFakeContext(queenstownTrip, { getRecommendationsNear });
    const res = await explore(ctx, { trip_key: "T", near: "Queenstown Gardens" });
    expect(res.isError).toBeUndefined();
    const call = getRecommendationsNear.mock.calls[0]![0] as { excludingPlaceIds: string[]; geoId: number };
    expect(call.geoId).toBe(2);
    expect(call.excludingPlaceIds.length).toBeGreaterThan(0);
    expect(res.content[0]!.text).toContain("Komyo-in Temple");
    expect(res.content[0]!.text).toMatch(/m away|km away/);
  });
});

// ---------------------------------------------------------------------------
// get_travel_times
// ---------------------------------------------------------------------------

describe("get_travel_times", () => {
  function tripWithRoutedDay(): { trip: TripPlan; day: TripPlan["itinerary"]["sections"][number] } {
    const trip = structuredClone(queenstownTrip);
    const placeBlocks = trip.itinerary.sections.flatMap((s) => s.blocks.filter((b) => b.type === "place"));
    const day = trip.itinerary.sections.find((s) => s.mode === "dayPlan")!;
    day.blocks = placeBlocks.slice(0, 2);
    return { trip, day };
  }

  it("builds one run per day and reports legs and totals", async () => {
    const { trip, day } = tripWithRoutedDay();
    const places = day.blocks.filter((b) => b.type === "place") as Array<{ place: { place_id: string; name: string } }>;
    expect(places.length).toBeGreaterThanOrEqual(2);
    const getDistances = vi.fn(async (args: { travelMode: string }) => {
      const out: Record<string, unknown> = {};
      for (let i = 0; i < places.length - 1; i++) {
        out[legKey(places[i]!.place.place_id, places[i + 1]!.place.place_id, args.travelMode)] = {
          fromPlaceId: places[i]!.place.place_id,
          toPlaceId: places[i + 1]!.place.place_id,
          travelMode: args.travelMode,
          route: { distance: { value: 1500, text: "1.5 km" }, duration: { value: 600, text: "10 min" } },
        };
      }
      return out;
    });
    const { ctx } = makeFakeContext(trip, { getDistances });
    const res = await getTravelTimes(ctx, { trip_key: "T", day: day.date!, travel_mode: "walking" });
    expect(res.isError).toBeUndefined();
    const call = getDistances.mock.calls[0]![0] as { travelMode: string; placeRuns: Array<{ sectionId: number; places: unknown[] }> };
    expect(call.travelMode).toBe("walking");
    expect(call.placeRuns).toHaveLength(1);
    expect(call.placeRuns[0]!.sectionId).toBe(day.id);
    expect(res.content[0]!.text).toContain(`${places[0]!.place.name} → ${places[1]!.place.name}: 10 min (1.5 km)`);
    expect(res.content[0]!.text).toContain("total");
  });

  it("defaults to the trip's default travel mode", async () => {
    const { trip } = tripWithRoutedDay();
    trip.itinerary.options = { defaultTravelMode: "transit" };
    const getDistances = vi.fn(async () => ({}));
    const { ctx } = makeFakeContext(trip, { getDistances });
    await getTravelTimes(ctx, { trip_key: "T" });
    expect((getDistances.mock.calls[0]![0] as { travelMode: string }).travelMode).toBe("transit");
  });

  it("explains when a day has fewer than two placed stops", async () => {
    const { ctx } = makeFakeContext(checklistTrip, { getDistances: vi.fn() });
    const res = await getTravelTimes(ctx, { trip_key: "T", day: "2026-06-04" });
    expect(res.isError).toBeUndefined();
    expect(res.content[0]!.text).toContain("fewer than two places");
  });
});

// ---------------------------------------------------------------------------
// collaborators
// ---------------------------------------------------------------------------

describe("collaborators", () => {
  const trip = withFriend(checklistTrip);

  it("resolves by username, name, @handle, and partial", () => {
    expect(findCollaborator(trip, "sam_travels")).toMatchObject({ kind: "unique", user: { id: FRIEND.id } });
    expect(findCollaborator(trip, "@Sam_Travels")).toMatchObject({ kind: "unique" });
    expect(findCollaborator(trip, "Sam Lee")).toMatchObject({ kind: "unique" });
    expect(findCollaborator(trip, "sam")).toMatchObject({ kind: "unique" });
    expect(findCollaborator(trip, "nobody")).toEqual({ kind: "none" });
  });

  it("lists tripmates with owner/you tags and pending invites", async () => {
    const { ctx } = makeFakeContext(trip, { listInvites: async () => [{ email: "new@example.com" }] });
    const res = await listCollaborators(ctx, { trip_key: "T" });
    expect(res.content[0]!.text).toContain("Ali (@ali1253) — owner, you");
    expect(res.content[0]!.text).toContain("Sam Lee (@sam_travels)");
    expect(res.content[0]!.text).toContain("new@example.com");
  });

  it("invites by email and resolved username, skipping existing tripmates", async () => {
    const inviteToTrip = vi.fn(async () => ({}));
    const userAutocomplete = vi.fn(async (q: string) =>
      q === "newbie" ? [{ id: 5, username: "newbie", name: "New Bie" }] : []);
    const { ctx, invalidate } = makeFakeContext(trip, { inviteToTrip, userAutocomplete });
    const res = await inviteCollaborator(ctx, {
      trip_key: "T",
      emails: ["a@example.com"],
      usernames: ["@newbie", "sam_travels"],
      message: "join!",
    });
    expect(res.isError).toBeUndefined();
    expect(inviteToTrip).toHaveBeenCalledWith(
      "T",
      [
        { type: "email", email: "a@example.com" },
        { type: "user", id: 5, username: "newbie", name: "New Bie", profilePictureKey: null },
      ],
      "join!",
    );
    expect(invalidate).toHaveBeenCalledWith("T");
    expect(res.content[0]!.text).toContain("Already tripmates: Sam Lee");
  });

  it("fails clearly on unknown usernames without inviting anyone", async () => {
    const inviteToTrip = vi.fn();
    const { ctx } = makeFakeContext(trip, { inviteToTrip, userAutocomplete: async () => [] });
    const res = await inviteCollaborator(ctx, { trip_key: "T", usernames: ["ghost"] });
    expect(res.isError).toBe(true);
    expect(inviteToTrip).not.toHaveBeenCalled();
  });

  it("removes a tripmate but refuses to remove the owner", async () => {
    const removeCollaboratorFn = vi.fn(async () => {});
    const { ctx } = makeFakeContext(trip, { removeCollaborator: removeCollaboratorFn });
    const ok = await removeCollaborator(ctx, { trip_key: "T", user: "sam" });
    expect(ok.isError).toBeUndefined();
    expect(removeCollaboratorFn).toHaveBeenCalledWith("T", FRIEND.id);
    const owner = await removeCollaborator(ctx, { trip_key: "T", user: "ali1253" });
    expect(owner.isError).toBe(true);
    expect(removeCollaboratorFn).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// budget
// ---------------------------------------------------------------------------

describe("budget", () => {
  const trip = withFriend(budgetTrip);

  it("resolveSplitWith handles everyone / none / names", () => {
    expect(resolveSplitWith(trip, undefined)).toBeUndefined();
    expect(resolveSplitWith(trip, ["none"])).toEqual({ type: "individuals", users: [] });
    expect(resolveSplitWith(trip, ["everyone"])!.users.map((u) => u.id).sort()).toEqual([ME, FRIEND.id].sort());
    expect(resolveSplitWith(trip, ["me", "Sam"], ME)!.users.map((u) => u.id)).toEqual([ME, FRIEND.id]);
    expect(() => resolveSplitWith(trip, ["stranger"], ME)).toThrow(/not a tripmate/);
  });

  it("set_budget creates the budget object when absent and patches when present", async () => {
    const bare = structuredClone(checklistTrip);
    delete (bare.itinerary as { budget?: unknown }).budget;
    const a = makeFakeContext(bare);
    const first = await setBudget(a.ctx, { trip_key: "T", amount: 5_000_000, currency: "idr" });
    expect(first.isError).toBeUndefined();
    expect(a.submittedOps[0]).toEqual([
      { p: ["itinerary", "budget"], oi: { expenses: [], amount: { amount: 5_000_000, currencyCode: "IDR" } } },
    ]);
    const second = await setBudget(a.ctx, { trip_key: "T", simplify_group_expenses: true, amount: 5_000_000 });
    expect(second.isError).toBeUndefined();
    expect(a.submittedOps[1]).toEqual([
      { p: ["itinerary", "budget", "simplifyDebt"], oi: true },
    ]);
    expect(a.entry.snapshot.itinerary.budget).toMatchObject({ simplifyDebt: true, amount: { currencyCode: "IDR" } });
  });

  it("add_expense records payer and split, and budget_summary computes balances", async () => {
    const { ctx, entry } = makeFakeContext(trip);
    const res = await addExpense(ctx, {
      trip_key: "T",
      amount: 100,
      currency: "usd",
      category: "food",
      description: "Group dinner",
      paid_by: "me",
      split_with: ["everyone"],
      date: "2026-05-04",
    });
    expect(res.isError).toBeUndefined();
    expect(res.content[0]!.text).toContain("split among");
    const added = entry.snapshot.itinerary.budget!.expenses!.find((e) => e.description === "Group dinner")!;
    expect(added.paidByUserId).toBe(ME);
    expect(added.splitWith).toEqual({
      type: "individuals",
      users: [{ type: "registered", id: ME }, { type: "registered", id: FRIEND.id }],
    });

    const summary = summariseBudget(entry.snapshot, ME);
    expect(summary).toContain("Balances from shared expenses");
    expect(summary).toContain("Sam Lee: −USD 50");
    expect(summary).toContain("Ali: +USD 50");
    expect(summary).toContain("By category");

    const tool = await budgetSummary(ctx, { trip_key: "T" });
    expect(tool.content[0]!.text).toBe(summary);
  });

  it("edit_expense can reassign payer and split", async () => {
    const { ctx, entry } = makeFakeContext(trip);
    const target = entry.snapshot.itinerary.budget!.expenses![0]!;
    const res = await editExpense(ctx, {
      trip_key: "T",
      description: target.description!,
      new_paid_by: "sam_travels",
      new_split_with: ["me"],
    });
    expect(res.isError).toBeUndefined();
    const after = entry.snapshot.itinerary.budget!.expenses![0]!;
    expect(after.paidByUserId).toBe(FRIEND.id);
    expect(after.paidByUser).toEqual({ type: "registered", id: FRIEND.id });
    expect(after.splitWith).toEqual({ type: "individuals", users: [{ type: "registered", id: ME }] });
  });
});

// ---------------------------------------------------------------------------
// update_trip default_travel_mode
// ---------------------------------------------------------------------------

describe("update_trip travel mode", () => {
  it("replaces itinerary.options preserving other keys", async () => {
    const trip = structuredClone(checklistTrip);
    trip.itinerary.options = { keep: 1 };
    const { ctx, submittedOps } = makeFakeContext(trip);
    const res = await updateTrip(ctx, { trip_key: "T", default_travel_mode: "transit" });
    expect(res.isError).toBeUndefined();
    expect(submittedOps[0]).toEqual([
      { p: ["itinerary", "options"], od: { keep: 1 }, oi: { keep: 1, defaultTravelMode: "transit" } },
    ]);
  });
});

// ---------------------------------------------------------------------------
// restaurant reservation
// ---------------------------------------------------------------------------

describe("add_restaurant_reservation", () => {
  it("formats the reservation note like the Wanderlog UI", () => {
    const delta = buildReservationText({ date: "2027-03-16", time: "13:00", partySize: 2, confirmationNumber: "R1" });
    expect(delta.ops[0]).toEqual({ insert: "Reservation at: ", attributes: { bold: true } });
    expect(delta.ops[1]!.insert).toBe("March 16, 2027 at 1:00 PM\n");
    expect(delta.ops.map((o) => o.insert).join("")).toContain("Party of 2");
    expect(delta.ops.map((o) => o.insert).join("")).toContain("R1");
  });

  it("creates the section on first use, appends on the second", async () => {
    const trip = structuredClone(checklistTrip);
    const detail = {
      name: "Ichiran Kyoto",
      place_id: "ChIJ_ichiran",
      geometry: { location: { lat: 35.0, lng: 135.76 } },
    };
    const { ctx, entry, submittedOps } = makeFakeContext(trip, {
      searchPlacesAutocomplete: async () => [{ place_id: detail.place_id, description: "Ichiran" }],
      getPlaceDetails: async () => detail,
      getPlacePhotos: async () => ["img1"],
    });
    expect(findRestaurantSection(entry.snapshot)).toBeNull();

    const first = await addRestaurantReservation(ctx, {
      trip_key: "T",
      restaurant: "Ichiran",
      date: "2026-06-03",
      time: "19:30",
      party_size: 4,
    });
    expect(first.isError).toBeUndefined();
    const created = findRestaurantSection(entry.snapshot);
    expect(created).not.toBeNull();
    expect(created!.section).toMatchObject({ heading: "Restaurant reservations", placeMarkerIcon: "utensils", type: "normal" });
    expect(created!.section.blocks).toHaveLength(1);
    const block = created!.section.blocks[0] as { startTime?: string; imageKeys?: string[]; place: { name: string } };
    expect(block.startTime).toBe("19:30");
    expect(block.imageKeys).toEqual(["img1"]);
    // Inserted before the first day section.
    const firstDay = entry.snapshot.itinerary.sections.findIndex((s) => s.mode === "dayPlan");
    expect(created!.index).toBeLessThan(firstDay);

    const second = await addRestaurantReservation(ctx, {
      trip_key: "T",
      restaurant: "Ichiran",
      date: "2026-06-04",
    });
    expect(second.isError).toBeUndefined();
    expect(findRestaurantSection(entry.snapshot)!.section.blocks).toHaveLength(2);
    expect(submittedOps).toHaveLength(2);
    expect(submittedOps[1]![0]!.p.slice(-2)).toEqual(["blocks", 1]);
  });

  it("rejects dates outside the trip", async () => {
    const { ctx, submittedOps } = makeFakeContext(checklistTrip, {});
    const res = await addRestaurantReservation(ctx, { trip_key: "T", restaurant: "X", date: "2030-01-01" });
    expect(res.isError).toBe(true);
    expect(submittedOps).toHaveLength(0);
  });
});
