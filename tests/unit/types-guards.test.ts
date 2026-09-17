import { describe, expect, it } from "vitest";
import { isTransitBlock, isRentalCarBlock, isFlightBlock, type Block } from "../../src/types.ts";

const ferry = { id: 1, type: "ferry", carrier: "CTM" } as unknown as Block;
const bus = { id: 2, type: "bus", carrier: "FlixBus" } as unknown as Block;
const train = { id: 3, type: "train", carrier: "SNCF" } as unknown as Block;
const rental = { id: 4, type: "rentalCar" } as unknown as Block;
const flight = { id: 5, type: "flight" } as unknown as Block;
const place = { id: 6, type: "place", place: { name: "X", place_id: "p" } } as unknown as Block;

describe("isTransitBlock", () => {
  it("matches ferry, bus, train and nothing else", () => {
    expect(isTransitBlock(ferry)).toBe(true);
    expect(isTransitBlock(bus)).toBe(true);
    expect(isTransitBlock(train)).toBe(true);
    expect(isTransitBlock(rental)).toBe(false);
    expect(isTransitBlock(flight)).toBe(false);
    expect(isTransitBlock(place)).toBe(false);
  });
});

describe("isRentalCarBlock", () => {
  it("matches only rentalCar", () => {
    expect(isRentalCarBlock(rental)).toBe(true);
    expect(isRentalCarBlock(ferry)).toBe(false);
    expect(isRentalCarBlock(flight)).toBe(false);
    expect(isRentalCarBlock(place)).toBe(false);
  });
});

describe("isFlightBlock", () => {
  it("matches only flight", () => {
    expect(isFlightBlock(flight)).toBe(true);
    expect(isFlightBlock(ferry)).toBe(false);
    expect(isFlightBlock(rental)).toBe(false);
    expect(isFlightBlock(place)).toBe(false);
  });
});
