import { z } from "zod";
import type { AppContext } from "../context.js";
import { WanderlogError, WanderlogNotFoundError, WanderlogValidationError } from "../errors.js";
import type { Json0Op } from "../ot/apply.js";
import { resolveDay } from "../resolvers/day.js";
import type { ChecklistBlock, ChecklistItem, TripPlan } from "../types.js";
import { isChecklistBlock } from "../types.js";
import { extractDeltaText } from "./remove-note.js";
import {
  assertBlockAtPath,
  findDaySectionByDate,
  findNotesSection,
  generateBlockId,
  resolveSectionRef,
  submitOp,
} from "./shared.js";

export const editChecklistInputSchema = {
  trip_key: z.string().min(1).describe("The trip containing the checklist."),
  checklist: z
    .string()
    .optional()
    .describe(
      "Checklist title (case-insensitive substring), e.g. 'Packing list'. Optional when the trip (or the given day/section) has only one checklist.",
    ),
  day: z
    .string()
    .optional()
    .describe(
      "Limit the search to one day or section: 'day 2', 'May 4', '2026-05-04', 'notes' (trip-level Notes), or a custom list heading.",
    ),
  check: z
    .array(z.string().min(1))
    .optional()
    .describe("Items to tick off, matched by case-insensitive substring of the item text."),
  uncheck: z
    .array(z.string().min(1))
    .optional()
    .describe("Items to un-tick, matched by case-insensitive substring of the item text."),
  add_items: z
    .array(z.string().min(1))
    .optional()
    .describe("New items to append to the end of the checklist (initially unchecked)."),
  remove_items: z
    .array(z.string().min(1))
    .optional()
    .describe("Items to delete, matched by case-insensitive substring of the item text."),
  new_title: z.string().optional().describe("Rename the checklist. Pass '' to clear the title."),
};

export const editChecklistDescription = `
Edits an existing checklist in a Wanderlog trip: tick or un-tick items, add items, remove
items, or rename it — any combination in one call.

The checklist is found by title substring (checklist), optionally scoped to a day, the
trip-level Notes section, or a custom list (day). If the scope contains exactly one checklist,
checklist can be omitted. Items are matched by case-insensitive substring; an exact match
wins over partial matches. Ambiguous references return a list instead of guessing.

To change the wording of an item, use wanderlog_edit_note (find-and-replace). To create a
new checklist, use wanderlog_add_checklist.
`.trim();

type Args = {
  trip_key: string;
  checklist?: string;
  day?: string;
  check?: string[];
  uncheck?: string[];
  add_items?: string[];
  remove_items?: string[];
  new_title?: string;
};

type ChecklistTarget = {
  sectionIndex: number;
  blockIndex: number;
  block: ChecklistBlock;
  location: string;
};

function describeLocation(trip: TripPlan, sectionIndex: number): string {
  const section = trip.itinerary.sections[sectionIndex]!;
  if (section.date) return `day ${section.date}`;
  return section.heading || (section.type === "textOnly" ? "Notes" : "unscheduled");
}

function scopeSectionIndices(trip: TripPlan, day?: string): number[] {
  const sections = trip.itinerary.sections;
  if (!day) return sections.map((_, i) => i);
  const normalized = day.trim().toLowerCase();
  if (normalized === "notes" || normalized === "note") {
    const notes = findNotesSection(trip);
    return notes ? [notes.index] : [];
  }
  try {
    const resolved = resolveDay(trip, day);
    const found = findDaySectionByDate(trip, resolved.date!);
    if (found) return [found.index];
  } catch {
    // Not a day reference — fall through to section headings.
  }
  const bySection = resolveSectionRef(trip, day);
  if (bySection.kind === "unique") return [bySection.match.index];
  if (bySection.kind === "ambiguous") return bySection.candidates.map((c) => c.index);
  throw new WanderlogNotFoundError("Day or section", day);
}

export function findChecklists(trip: TripPlan, day?: string): ChecklistTarget[] {
  const targets: ChecklistTarget[] = [];
  for (const sectionIndex of scopeSectionIndices(trip, day)) {
    const section = trip.itinerary.sections[sectionIndex]!;
    section.blocks.forEach((block, blockIndex) => {
      if (isChecklistBlock(block)) {
        targets.push({
          sectionIndex,
          blockIndex,
          block,
          location: describeLocation(trip, sectionIndex),
        });
      }
    });
  }
  return targets;
}

function itemText(item: ChecklistItem): string {
  return extractDeltaText(item.text).replace(/\n$/, "");
}

function checklistLabel(t: ChecklistTarget): string {
  const title = t.block.title?.trim() || "(untitled checklist)";
  return `${title} — ${t.location}, ${t.block.items.length} items`;
}

/**
 * Match a query against item texts. Exact (case-insensitive) matches take
 * precedence over substring matches so "maps" doesn't collide with "offline maps"
 * when both exist.
 */
function matchItems(items: ChecklistItem[], query: string): number[] {
  const q = query.trim().toLowerCase();
  const texts = items.map((it) => itemText(it).toLowerCase());
  const exact = texts.flatMap((t, i) => (t === q ? [i] : []));
  if (exact.length > 0) return exact;
  return texts.flatMap((t, i) => (t.includes(q) ? [i] : []));
}

function resolveItem(target: ChecklistTarget, query: string, verb: string): number {
  const matches = matchItems(target.block.items, query);
  if (matches.length === 1) return matches[0]!;
  const title = target.block.title?.trim() || "(untitled checklist)";
  if (matches.length === 0) {
    throw new WanderlogNotFoundError(`Item to ${verb} in "${title}"`, query);
  }
  const list = matches.map((i) => `  • ${itemText(target.block.items[i]!)}`).join("\n");
  throw new WanderlogValidationError(
    `"${query}" matches several items in "${title}":\n${list}`,
    "Use a longer, more specific substring.",
  );
}

export async function editChecklist(
  ctx: AppContext,
  args: Args,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const hasEdit =
      (args.check?.length ?? 0) > 0 ||
      (args.uncheck?.length ?? 0) > 0 ||
      (args.add_items?.length ?? 0) > 0 ||
      (args.remove_items?.length ?? 0) > 0 ||
      args.new_title !== undefined;
    if (!hasEdit) {
      throw new WanderlogValidationError(
        "Provide at least one of check, uncheck, add_items, remove_items, or new_title.",
      );
    }

    const result = await submitOp(ctx, args.trip_key, async (entry, submit) => {
      const trip = entry.snapshot;
      let candidates = findChecklists(trip, args.day);
      if (args.checklist) {
        const q = args.checklist.trim().toLowerCase();
        const exact = candidates.filter((c) => (c.block.title ?? "").trim().toLowerCase() === q);
        candidates = exact.length > 0
          ? exact
          : candidates.filter((c) => (c.block.title ?? "").toLowerCase().includes(q));
      }
      if (candidates.length === 0) {
        const scope = args.day ? ` in ${args.day}` : "";
        throw new WanderlogNotFoundError(
          `Checklist${scope}`,
          args.checklist,
        );
      }
      if (candidates.length > 1) {
        const lines = candidates.map((c, i) => `  ${i + 1}. ${checklistLabel(c)}`);
        return {
          response: {
            content: [
              {
                type: "text" as const,
                text: `Several checklists match in "${trip.title}":\n${lines.join("\n")}\n\nRetry with the checklist title and/or a day filter.`,
              },
            ],
          },
        };
      }

      const target = candidates[0]!;
      const block = assertBlockAtPath(
        trip,
        target.sectionIndex,
        target.blockIndex,
        target.block.id,
      ) as ChecklistBlock;
      const base = ["itinerary", "sections", target.sectionIndex, "blocks", target.blockIndex];
      const ops: Json0Op[] = [];
      const summary: string[] = [];

      if (args.new_title !== undefined && args.new_title !== (block.title ?? "")) {
        const op: Json0Op = { p: [...base, "title"], oi: args.new_title };
        if ("title" in block) op.od = block.title;
        ops.push(op);
        summary.push(`renamed to "${args.new_title || "(untitled)"}"`);
      }

      const toggle = (queries: string[] | undefined, checked: boolean) => {
        const done: string[] = [];
        for (const q of queries ?? []) {
          const idx = resolveItem(target, q, checked ? "check" : "uncheck");
          const item = block.items[idx]!;
          if (item.checked === checked) continue;
          ops.push({ p: [...base, "items", idx, "checked"], od: item.checked, oi: checked });
          done.push(itemText(item));
        }
        if (done.length > 0) {
          summary.push(`${checked ? "checked" : "unchecked"}: ${done.join(", ")}`);
        }
      };
      toggle(args.check, true);
      toggle(args.uncheck, false);

      const removeIdx = new Set<number>();
      for (const q of args.remove_items ?? []) {
        removeIdx.add(resolveItem(target, q, "remove"));
      }
      if (removeIdx.size > 0) {
        // Descending order so earlier deletions don't shift later indices.
        const sorted = [...removeIdx].sort((a, b) => b - a);
        for (const idx of sorted) {
          ops.push({ p: [...base, "items", idx], ld: block.items[idx] });
        }
        summary.push(
          `removed: ${[...removeIdx].sort((a, b) => a - b).map((i) => itemText(block.items[i]!)).join(", ")}`,
        );
      }

      const adds = (args.add_items ?? []).map((t) => t.trim()).filter(Boolean);
      if (adds.length > 0) {
        let nextIndex = block.items.length - removeIdx.size;
        for (const text of adds) {
          const item: ChecklistItem = {
            id: generateBlockId(),
            checked: false,
            text: { ops: [{ insert: `${text}\n` }] },
          };
          ops.push({ p: [...base, "items", nextIndex++], li: item });
        }
        summary.push(`added: ${adds.join(", ")}`);
      }

      const title = block.title?.trim() || "(untitled checklist)";
      if (ops.length === 0) {
        return { title, location: target.location, summary: [], tripTitle: trip.title };
      }
      await submit(ops);
      return { title, location: target.location, summary, tripTitle: trip.title };
    });
    if ("response" in result && result.response) return result.response;

    const text = result.summary.length === 0
      ? `Checklist "${result.title}" (${result.location}) already matched the request — no change made.`
      : `Updated checklist "${result.title}" (${result.location}) in "${result.tripTitle}": ${result.summary.join("; ")}.`;
    return { content: [{ type: "text", text }] };
  } catch (err) {
    const msg =
      err instanceof WanderlogError
        ? err.toUserMessage()
        : `Unexpected error: ${(err as Error).message}`;
    return { content: [{ type: "text", text: msg }], isError: true };
  }
}
