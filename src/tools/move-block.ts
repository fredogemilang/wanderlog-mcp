import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { AppContext } from "../context.js";
import {
  WanderlogError,
  WanderlogValidationError,
} from "../errors.js";
import type { Json0Op } from "../ot/apply.js";
import {
  resolvePlaceRef,
  type PlaceRefMatch,
} from "../resolvers/place-ref.js";
import type { Block, Section, TripPlan } from "../types.js";
import { isPlaceBlock, isTransitBlock } from "../types.js";
import { submitOp } from "./shared.js";

export const moveBlockInputSchema = z
  .object({
    trip_key: z.string().min(1).describe("The trip containing the block."),
    block: z
      .string()
      .min(1)
      .describe(
        "Natural-language reference to the place or reservation block to move. Uses the same names, role keywords, day filters, and ordinal prefixes as wanderlog_remove_place.",
      ),
    position: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe(
        "Move to this 1-based position in the section's complete displayed block order, including notes and checklists.",
      ),
    before: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Move immediately before this naturally referenced place or reservation block in the same section. Notes and checklists are not valid targets.",
      ),
    after: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Move immediately after this naturally referenced place or reservation block in the same section. Notes and checklists are not valid targets.",
      ),
  })
  .refine(
    (args) =>
      [args.position, args.before, args.after].filter(
        (value) => value !== undefined,
      ).length === 1,
    {
      message: "Provide exactly one of position, before, or after.",
    },
  );

export const moveBlockDescription = `
Moves an existing place or reservation block to another position within its current Wanderlog
section without deleting or recreating it. The original block ID, notes, images, times, booking
details, and other metadata are preserved.

Select the block using the same natural-language references as wanderlog_remove_place, including
day filters and ordinal prefixes. Choose exactly one destination:
  - position: a 1-based position in the section's complete displayed block order
  - before: another place or reservation block in the same section
  - after: another place or reservation block in the same section

Positions count all displayed blocks, including notes and checklists — but notes and checklists
cannot be used as before/after targets, which resolve only to place or reservation blocks.
Cross-section moves are not supported; do not emulate them by removing and re-adding the block,
which discards its ID, notes, times, and booking details. If a reference is ambiguous, nothing is
changed and the tool returns candidates for a more specific retry.
`.trim();

type Args = z.infer<typeof moveBlockInputSchema>;

type MoveOutcome = {
  moved: boolean;
  blockName: string;
  sectionLabel: string;
  tripTitle: string;
  fromPosition: number;
  toPosition: number;
};

export async function moveBlock(
  ctx: AppContext,
  args: Args,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    // The MCP SDK unwraps refined Zod objects before protocol validation.
    const parsed = moveBlockInputSchema.safeParse(args);
    if (!parsed.success) {
      throw new WanderlogValidationError(
        parsed.error.issues[0]?.message ?? "Invalid move destination.",
      );
    }

    const outcome = await submitOp(
      ctx,
      parsed.data.trip_key,
      async (entry, submit) => {
        const prepared = buildMove(entry.snapshot, parsed.data);
        if (prepared.ops.length === 0) {
          return prepared.afterApply(entry.snapshot);
        }

        await submit(prepared.ops);
        try {
          return prepared.afterApply(entry.snapshot);
        } catch (err) {
          ctx.tripCache.invalidate(parsed.data.trip_key);
          throw err;
        }
      },
    );

    const text = outcome.moved
      ? `Moved ${outcome.blockName} from position ${outcome.fromPosition} to position ${outcome.toPosition} in ${outcome.sectionLabel} of "${outcome.tripTitle}".`
      : `${outcome.blockName} is already at position ${outcome.toPosition} in ${outcome.sectionLabel} of "${outcome.tripTitle}". No changes made.`;
    return { content: [{ type: "text", text }] };
  } catch (err) {
    const msg =
      err instanceof WanderlogError
        ? err.toUserMessage()
        : `Unexpected error: ${(err as Error).message}`;
    return { content: [{ type: "text", text: msg }], isError: true };
  }
}

function buildMove(
  trip: TripPlan,
  args: Args,
): {
  ops: Json0Op[];
  afterApply: (snapshot: TripPlan) => MoveOutcome;
} {
  const source = resolveUniqueBlock(trip, args.block, "block");
  const sourceIndex = source.blockIndex;
  let destinationIndex: number;

  if (args.position !== undefined) {
    if (args.position > source.section.blocks.length) {
      throw new WanderlogValidationError(
        `Position ${args.position} is outside ${formatSection(source.section)}, which has ${source.section.blocks.length} blocks.`,
        `Use a position from 1 to ${source.section.blocks.length}, or use before/after with another block in the section.`,
      );
    }
    destinationIndex = args.position - 1;
  } else {
    const relation = args.before !== undefined ? "before" : "after";
    const targetRef = args.before ?? args.after!;
    const target = resolveUniqueBlock(trip, targetRef, `${relation} target`);

    if (target.sectionIndex !== source.sectionIndex) {
      throw new WanderlogValidationError(
        `Cannot move ${blockName(source.block)} ${relation} ${blockName(target.block)} because they are in different sections.`,
        "Cross-section moves are not supported. Choose a target in the same day or section.",
      );
    }
    if (target.block.id === source.block.id) {
      throw new WanderlogValidationError(
        `Cannot move ${blockName(source.block)} ${relation} itself.`,
      );
    }

    const targetIndex = target.blockIndex;
    if (relation === "before") {
      destinationIndex =
        targetIndex < sourceIndex ? targetIndex : targetIndex - 1;
    } else {
      destinationIndex =
        targetIndex < sourceIndex ? targetIndex + 1 : targetIndex;
    }
  }

  const originalBlock = structuredClone(source.block);
  const outcome: MoveOutcome = {
    moved: destinationIndex !== sourceIndex,
    blockName: blockName(source.block),
    sectionLabel: formatSection(source.section),
    tripTitle: trip.title,
    fromPosition: sourceIndex + 1,
    toPosition: destinationIndex + 1,
  };
  const ops: Json0Op[] =
    destinationIndex === sourceIndex
      ? []
      : [
          {
            p: [
              "itinerary",
              "sections",
              source.sectionIndex,
              "blocks",
              sourceIndex,
            ],
            lm: destinationIndex,
          },
        ];

  return {
    ops,
    afterApply: (snapshot) => {
      const section = snapshot.itinerary.sections.find(
        (candidate) => candidate.id === source.section.id,
      );
      const movedBlock = section?.blocks[destinationIndex];
      if (
        !movedBlock ||
        movedBlock.id !== originalBlock.id ||
        !isDeepStrictEqual(movedBlock, originalBlock)
      ) {
        throw new WanderlogError(
          `The move was accepted but could not be verified. It may have been applied; refresh "${trip.title}" before retrying.`,
          "move_verification_failed",
          "Use wanderlog_get_trip to inspect the current itinerary order before making another move.",
        );
      }
      return outcome;
    },
  };
}

function resolveUniqueBlock(
  trip: TripPlan,
  ref: string,
  label: string,
): PlaceRefMatch {
  const result = resolvePlaceRef(trip, ref);
  if (result.kind === "none") {
    throw new WanderlogValidationError(
      `No itinerary block matching "${ref}" was found in "${trip.title}".`,
      "Use wanderlog_get_trip to inspect the current itinerary, then retry with a more specific name or role.",
    );
  }
  if (result.kind === "ambiguous") {
    const candidates = result.candidates
      .map(
        (candidate, index) =>
          `  ${index + 1}. ${blockName(candidate.block)} — ${formatSection(candidate.section)}`,
      )
      .join("\n");
    throw new WanderlogValidationError(
      `The ${label} reference "${ref}" is ambiguous:\n${candidates}`,
      `Retry with an ordinal prefix such as "1st ${ref}" or add a day filter.`,
    );
  }
  return result.match;
}

function blockName(block: Block): string {
  if (isPlaceBlock(block)) return block.place.name;
  if (block.type === "flight") {
    const flightInfo = "flightInfo" in block ? block.flightInfo : undefined;
    const airline = flightInfo?.airline?.iata;
    const number = flightInfo?.number;
    return airline || number ? `${airline ?? ""}${number ?? ""} flight` : "flight";
  }
  if (isTransitBlock(block)) {
    return block.carrier ? `${block.carrier} ${block.type}` : block.type;
  }
  if (block.type === "rentalCar") return "rental car";
  return `${block.type} block`;
}

function formatSection(section: Section): string {
  if (section.mode === "dayPlan" && section.date) {
    return `day ${section.date}`;
  }
  return `"${section.heading || section.type}"`;
}
