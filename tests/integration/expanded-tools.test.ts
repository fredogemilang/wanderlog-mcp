import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createContext, type AppContext } from "../../src/context.ts";
import { addChecklist } from "../../src/tools/add-checklist.ts";
import { addExpense } from "../../src/tools/add-expense.ts";
import { addFlight } from "../../src/tools/add-flight.ts";
import { addPlace } from "../../src/tools/add-place.ts";
import { addRestaurantReservation, findRestaurantSection } from "../../src/tools/add-restaurant-reservation.ts";
import { budgetSummary, setBudget } from "../../src/tools/budget.ts";
import { listCollaborators } from "../../src/tools/collaborators.ts";
import { createTrip } from "../../src/tools/create-trip.ts";
import { deleteTrip } from "../../src/tools/delete-trip.ts";
import { editChecklist } from "../../src/tools/edit-checklist.ts";
import { editReservation } from "../../src/tools/edit-reservation.ts";
import { explore } from "../../src/tools/explore.ts";
import { getPlaceDetails } from "../../src/tools/get-place-details.ts";
import { getTravelTimes } from "../../src/tools/get-travel-times.ts";
import { updateTrip } from "../../src/tools/update-trip.ts";
import type { ChecklistBlock, FlightBlock } from "../../src/types.ts";
import { isChecklistBlock, isFlightBlock } from "../../src/types.ts";

/**
 * Live round-trip for the tools added in the coverage expansion. Creates a
 * throwaway Kyoto trip ("WANDERDOG_TEST_<timestamp>"), exercises every new
 * tool against it, then deletes it through wanderlog_delete_trip itself.
 */
describe("Expanded tools (live round-trip)", () => {
  let ctx: AppContext;
  let tripKey: string | undefined;

  beforeAll(async () => {
    if (!process.env.WANDERLOG_COOKIE) {
      throw new Error("WANDERLOG_COOKIE must be set");
    }
    ctx = createContext();
    const user = await ctx.rest.getUser();
    ctx.userId = user.id;
    ctx.authenticated = true;
  }, 20_000);

  afterAll(async () => {
    ctx?.pool.closeAll();
    if (tripKey) {
      try {
        await ctx.rest.deleteTrip(tripKey);
      } catch {
        // already deleted by the delete_trip test, or best-effort cleanup
      }
    }
  });

  it("creates a Kyoto trip", async () => {
    const result = await createTrip(ctx, {
      destination: "Kyoto",
      start_date: "2099-03-01",
      end_date: "2099-03-03",
      title: `WANDERDOG_TEST_${Date.now()}`,
      privacy: "private",
    });
    expect(result.isError).not.toBe(true);
    tripKey = /Key: (\w+)/.exec(result.content[0]!.text)![1]!;
  }, 15_000);

  it("update_trip renames, changes privacy and default travel mode", async () => {
    const res = await updateTrip(ctx, {
      trip_key: tripKey!,
      title: "WANDERDOG_TEST renamed",
      privacy: "friends",
      default_travel_mode: "transit",
    });
    if (res.isError) throw new Error(res.content[0]!.text);
    ctx.tripCache.invalidate(tripKey!);
    const trip = await ctx.rest.getTrip(tripKey!);
    expect(trip.title).toBe("WANDERDOG_TEST renamed");
    expect(trip.privacy).toBe("friends");
    expect(trip.itinerary.options?.defaultTravelMode).toBe("transit");
  }, 30_000);

  it("explore returns an overview and a category list for Kyoto", async () => {
    const overview = await explore(ctx, { trip_key: tripKey! });
    if (overview.isError) throw new Error(overview.content[0]!.text);
    expect(overview.content[0]!.text).toContain("Explore Kyoto");
    expect(overview.content[0]!.text).toMatch(/Top places to visit|Top places to eat/);

    const temples = await explore(ctx, { trip_key: tripKey!, category: "temples", limit: 3, response_format: "detailed" });
    if (temples.isError) throw new Error(temples.content[0]!.text);
    expect(temples.content[0]!.text).toMatch(/1\. .+/);
    expect(temples.content[0]!.text).toContain("place_id: ChIJ");
  }, 30_000);

  it("adds two places to day 1 and computes travel times", async () => {
    for (const place of ["Fushimi Inari Taisha", "Kiyomizu-dera"]) {
      const res = await addPlace(ctx, { trip_key: tripKey!, place, day: "day 1" });
      if (res.isError) throw new Error(`add_place failed: ${res.content[0]!.text}`);
    }
    const res = await getTravelTimes(ctx, { trip_key: tripKey!, day: "day 1", travel_mode: "driving" });
    if (res.isError) throw new Error(res.content[0]!.text);
    expect(res.content[0]!.text).toMatch(/Fushimi Inari Taisha → Kiyomizu-dera: .+ \(.+\)/);
    expect(res.content[0]!.text).toContain("total");
  }, 60_000);

  it("explore near a place returns nearby recommendations", async () => {
    const res = await explore(ctx, { trip_key: tripKey!, near: "Fushimi Inari Taisha", limit: 5 });
    if (res.isError) throw new Error(res.content[0]!.text);
    expect(res.content[0]!.text).toContain("Recommended near Fushimi Inari Taisha");
    expect(res.content[0]!.text).toMatch(/1\. .+ — .+ away/);
  }, 30_000);

  it("get_place_details returns hours for a place in the trip", async () => {
    const res = await getPlaceDetails(ctx, { trip_key: tripKey!, place: "Kiyomizu-dera" });
    if (res.isError) throw new Error(res.content[0]!.text);
    expect(res.content[0]!.text).toContain("Kiyomizu-dera");
    expect(res.content[0]!.text).toMatch(/Rating: ★/);
    expect(res.content[0]!.text).toContain("in \"WANDERDOG_TEST renamed\"");
  }, 30_000);

  it("edit_checklist ticks, adds and removes items", async () => {
    const created = await addChecklist(ctx, {
      trip_key: tripKey!,
      title: "Pre-trip",
      items: ["Passport", "JR Pass", "Cash"],
    });
    if (created.isError) throw new Error(created.content[0]!.text);
    const res = await editChecklist(ctx, {
      trip_key: tripKey!,
      checklist: "Pre-trip",
      check: ["Passport"],
      remove_items: ["Cash"],
      add_items: ["Suica card"],
    });
    if (res.isError) throw new Error(res.content[0]!.text);
    ctx.tripCache.invalidate(tripKey!);
    const trip = await ctx.rest.getTrip(tripKey!);
    const checklist = trip.itinerary.sections
      .flatMap((s) => s.blocks)
      .find((b): b is ChecklistBlock => isChecklistBlock(b) && b.title === "Pre-trip")!;
    const items = checklist.items.map((i) => ({
      text: (i.text?.ops?.[0]?.insert as string).trim(),
      checked: i.checked,
    }));
    expect(items).toEqual([
      { text: "Passport", checked: true },
      { text: "JR Pass", checked: false },
      { text: "Suica card", checked: false },
    ]);
  }, 60_000);

  it("edit_reservation patches a flight in place", async () => {
    const added = await addFlight(ctx, {
      trip_key: tripKey!,
      airline: "JL",
      flight_number: "123",
      from_airport: "Haneda Airport",
      to_airport: "Osaka Itami Airport",
      depart_date: "2099-03-01",
      depart_time: "08:00",
      arrive_date: "2099-03-01",
      arrive_time: "09:15",
    });
    if (added.isError) throw new Error(added.content[0]!.text);
    const res = await editReservation(ctx, {
      trip_key: tripKey!,
      reservation: "the flight",
      confirmation_number: "ABC123",
      start_time: "08:30",
      traveler_names: ["Test Traveler"],
    });
    if (res.isError) throw new Error(res.content[0]!.text);
    ctx.tripCache.invalidate(tripKey!);
    const trip = await ctx.rest.getTrip(tripKey!);
    const flight = trip.itinerary.sections.flatMap((s) => s.blocks).find(isFlightBlock) as FlightBlock;
    expect(flight.confirmationNumber).toBe("ABC123");
    expect(flight.depart?.time).toBe("08:30");
    expect(flight.arrive?.time).toBe("09:15");
    expect(flight.travelerNames).toEqual(["Test Traveler"]);
  }, 60_000);

  it("add_restaurant_reservation creates the section with a timed place", async () => {
    const res = await addRestaurantReservation(ctx, {
      trip_key: tripKey!,
      restaurant: "Ichiran Kyoto Kawaramachi",
      date: "2099-03-02",
      time: "19:00",
      party_size: 2,
      confirmation_number: "R-42",
    });
    if (res.isError) throw new Error(res.content[0]!.text);
    ctx.tripCache.invalidate(tripKey!);
    const trip = await ctx.rest.getTrip(tripKey!);
    const section = findRestaurantSection(trip);
    expect(section).not.toBeNull();
    expect(section!.section.placeMarkerIcon).toBe("utensils");
    const block = section!.section.blocks[0] as { startTime?: string; text?: { ops?: Array<{ insert?: string }> } };
    expect(block.startTime).toBe("19:00");
    expect(block.text?.ops?.map((o) => o.insert).join("")).toContain("March 2, 2099 at 7:00 PM");
  }, 60_000);

  it("budget: set target, add split expense, summarise", async () => {
    const set = await setBudget(ctx, { trip_key: tripKey!, amount: 200_000, currency: "JPY", simplify_group_expenses: true });
    if (set.isError) throw new Error(set.content[0]!.text);
    const exp = await addExpense(ctx, {
      trip_key: tripKey!,
      amount: 12_000,
      currency: "JPY",
      category: "food",
      description: "Group dinner",
      paid_by: "me",
      split_with: ["everyone"],
      date: "2099-03-02",
    });
    if (exp.isError) throw new Error(exp.content[0]!.text);
    ctx.tripCache.invalidate(tripKey!);
    const trip = await ctx.rest.getTrip(tripKey!);
    expect(trip.itinerary.budget?.amount).toEqual({ amount: 200_000, currencyCode: "JPY" });
    expect(trip.itinerary.budget?.simplifyDebt).toBe(true);
    const dinner = trip.itinerary.budget?.expenses?.find((e) => e.description === "Group dinner");
    expect(dinner?.paidByUserId).toBe(ctx.userId);
    expect((dinner?.splitWith as { users: unknown[] }).users.length).toBeGreaterThan(0);

    const summary = await budgetSummary(ctx, { trip_key: tripKey! });
    expect(summary.content[0]!.text).toContain("Target: JPY 200,000");
    expect(summary.content[0]!.text).toContain("food: JPY 12,000");
  }, 60_000);

  it("list_collaborators shows the owner", async () => {
    const res = await listCollaborators(ctx, { trip_key: tripKey! });
    if (res.isError) throw new Error(res.content[0]!.text);
    expect(res.content[0]!.text).toContain("owner, you");
  }, 30_000);

  it("delete_trip refuses a wrong title, then deletes with the right one", async () => {
    const wrong = await deleteTrip(ctx, { trip_key: tripKey!, confirm_title: "nope" });
    expect(wrong.isError).toBe(true);
    const ok = await deleteTrip(ctx, { trip_key: tripKey!, confirm_title: "WANDERDOG_TEST renamed" });
    if (ok.isError) throw new Error(ok.content[0]!.text);
    expect(ok.content[0]!.text).toContain("Deleted trip");
    await expect(ctx.rest.getTrip(tripKey!)).rejects.toThrow();
    tripKey = undefined;
  }, 30_000);
});
