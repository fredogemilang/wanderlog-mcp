import { z } from "zod";
import type { AppContext } from "../context.js";
import { WanderlogError, WanderlogValidationError } from "../errors.js";
import type { Json0Op } from "../ot/apply.js";
import type { Contributor, Expense, TripPlan } from "../types.js";
import { collaboratorsOf, findCollaborator } from "./collaborators.js";
import { submitOp } from "./shared.js";

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

function fail(err: unknown): ToolResult {
  const msg =
    err instanceof WanderlogError
      ? err.toUserMessage()
      : `Unexpected error: ${(err as Error).message}`;
  return { content: [{ type: "text", text: msg }], isError: true };
}

// ---------------------------------------------------------------------------
// People references shared with add_expense / edit_expense
// ---------------------------------------------------------------------------

export type RegisteredUserRef = { type: "registered"; id: number };
export type SplitWith = { type: "individuals"; users: RegisteredUserRef[] };

export function resolvePerson(trip: TripPlan, ref: string, selfId?: number): Contributor {
  const q = ref.trim().toLowerCase();
  if ((q === "me" || q === "you" || q === "myself") && selfId) {
    const self = collaboratorsOf(trip).find((c) => c.id === selfId);
    if (self) return self;
    return { id: selfId, username: "me" };
  }
  const found = findCollaborator(trip, ref);
  if (found.kind === "unique") return found.user;
  const names = collaboratorsOf(trip).map((c) => `@${c.username}${c.name ? ` (${c.name})` : ""}`);
  if (found.kind === "ambiguous") {
    throw new WanderlogValidationError(
      `"${ref}" matches several tripmates: ${found.users.map((u) => `@${u.username}`).join(", ")}. Use the exact username.`,
    );
  }
  throw new WanderlogValidationError(
    `"${ref}" is not a tripmate on "${trip.title}". Tripmates: ${names.join(", ")}`,
    "Invite them first with wanderlog_invite_collaborator, or omit the person to default to you.",
  );
}

/**
 * Translate a split_with argument into Wanderlog's splitWith object.
 *   "everyone" → all tripmates · "none" / [] → nobody (not split) · names → those people
 */
export function resolveSplitWith(
  trip: TripPlan,
  splitWith: string[] | undefined,
  selfId?: number,
): SplitWith | undefined {
  if (splitWith === undefined) return undefined;
  const flat = splitWith.map((s) => s.trim()).filter(Boolean);
  if (flat.length === 0 || (flat.length === 1 && /^(none|nobody|no)$/i.test(flat[0]!))) {
    return { type: "individuals", users: [] };
  }
  if (flat.length === 1 && /^(everyone|everybody|all)$/i.test(flat[0]!)) {
    return {
      type: "individuals",
      users: collaboratorsOf(trip).map((c) => ({ type: "registered" as const, id: c.id })),
    };
  }
  const ids = new Set<number>();
  for (const ref of flat) ids.add(resolvePerson(trip, ref, selfId).id);
  return { type: "individuals", users: [...ids].map((id) => ({ type: "registered" as const, id })) };
}

export function personLabel(trip: TripPlan, id: number, selfId?: number): string {
  const c = collaboratorsOf(trip).find((x) => x.id === id);
  if (c) return c.name || `@${c.username}`;
  if (selfId && id === selfId) return "you";
  return `user #${id}`;
}

// ---------------------------------------------------------------------------
// set_budget
// ---------------------------------------------------------------------------

export const setBudgetInputSchema = {
  trip_key: z.string().min(1).describe("The trip whose budget settings to change."),
  amount: z
    .number()
    .min(0)
    .optional()
    .describe("Total trip budget target. Pass 0 to clear the target."),
  currency: z
    .string()
    .length(3)
    .optional()
    .describe("ISO 4217 code for the budget amount (e.g. 'JPY'). Defaults to the current budget currency, then USD."),
  simplify_group_expenses: z
    .boolean()
    .optional()
    .describe("Wanderlog's 'Simplify group expenses' toggle — nets out who-owes-whom into fewer transactions."),
};

export const setBudgetDescription = `
Sets the trip's total budget target and/or the "simplify group expenses" setting shown in
Wanderlog's Budgeting panel. Expenses themselves are managed with wanderlog_add_expense /
wanderlog_edit_expense; use wanderlog_budget_summary to see spend vs. budget.
`.trim();

type SetBudgetArgs = {
  trip_key: string;
  amount?: number;
  currency?: string;
  simplify_group_expenses?: boolean;
};

export async function setBudget(ctx: AppContext, args: SetBudgetArgs): Promise<ToolResult> {
  try {
    if (args.amount === undefined && args.simplify_group_expenses === undefined) {
      throw new WanderlogValidationError("Provide amount and/or simplify_group_expenses.");
    }
    const result = await submitOp(ctx, args.trip_key, async (entry, submit) => {
      const trip = entry.snapshot;
      const budget = trip.itinerary.budget ?? {};
      const ops: Json0Op[] = [];
      const changes: string[] = [];
      const hasBudget = "budget" in trip.itinerary;

      // The budget object may not exist yet on a fresh trip; create it whole
      // rather than writing into a missing parent.
      const pending: Record<string, unknown> = {};

      if (args.amount !== undefined) {
        const currency = (args.currency ?? budget.amount?.currencyCode ?? "USD").toUpperCase();
        const next = { amount: args.amount, currencyCode: currency };
        if (budget.amount?.amount !== next.amount || budget.amount?.currencyCode !== next.currencyCode) {
          pending.amount = next;
          changes.push(args.amount === 0 ? "budget target cleared" : `budget target → ${currency} ${args.amount.toLocaleString()}`);
        }
      }
      if (args.simplify_group_expenses !== undefined && budget.simplifyDebt !== args.simplify_group_expenses) {
        pending.simplifyDebt = args.simplify_group_expenses;
        changes.push(`simplify group expenses → ${args.simplify_group_expenses ? "on" : "off"}`);
      }

      if (Object.keys(pending).length === 0) {
        return { changes, tripTitle: trip.title };
      }
      if (!hasBudget) {
        ops.push({ p: ["itinerary", "budget"], oi: { expenses: [], ...pending } });
      } else {
        for (const [key, value] of Object.entries(pending)) {
          const op: Json0Op = { p: ["itinerary", "budget", key], oi: value };
          if (key in budget) op.od = (budget as Record<string, unknown>)[key];
          ops.push(op);
        }
      }
      await submit(ops);
      return { changes, tripTitle: trip.title };
    });

    const text = result.changes.length === 0
      ? `Budget settings for "${result.tripTitle}" already match — no change made.`
      : `Updated budget for "${result.tripTitle}": ${result.changes.join("; ")}.`;
    return { content: [{ type: "text", text }] };
  } catch (err) {
    return fail(err);
  }
}

// ---------------------------------------------------------------------------
// budget_summary
// ---------------------------------------------------------------------------

export const budgetSummaryInputSchema = {
  trip_key: z.string().min(1).describe("The trip to summarise."),
};

export const budgetSummaryDescription = `
Summarises a trip's budget: total spent vs. the budget target, spend by category, spend by
day, who paid what, and — for shared expenses — the net balance per tripmate (who owes whom).
Amounts are grouped per currency; no conversion is applied.
`.trim();

type Money = Map<string, number>; // currency → amount

function add(m: Money, currency: string, amount: number): void {
  m.set(currency, (m.get(currency) ?? 0) + amount);
}

function fmtMoney(m: Money): string {
  if (m.size === 0) return "0";
  return [...m.entries()].map(([c, a]) => `${c} ${round(a).toLocaleString()}`).join(" + ");
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

function payerId(e: Expense): number | undefined {
  const paidBy = e.paidByUser as { id?: number } | undefined;
  return (e.paidByUserId as number | undefined) ?? paidBy?.id;
}

function splitIds(e: Expense): number[] {
  const sw = e.splitWith as { users?: Array<{ id?: number }> } | undefined;
  return (sw?.users ?? []).map((u) => u.id).filter((id): id is number => typeof id === "number");
}

export function summariseBudget(trip: TripPlan, selfId?: number): string {
  const budget = trip.itinerary.budget ?? {};
  const expenses = budget.expenses ?? [];
  const out: string[] = [`Budget for "${trip.title}"`];

  const total: Money = new Map();
  const byCategory = new Map<string, Money>();
  const byDay = new Map<string, Money>();
  const paidBy = new Map<number, Money>();
  const balance = new Map<number, Money>(); // + means is owed, − means owes

  for (const e of expenses) {
    const cur = e.amount?.currencyCode ?? "?";
    const amt = e.amount?.amount ?? 0;
    add(total, cur, amt);
    const cat = e.category ?? "other";
    if (!byCategory.has(cat)) byCategory.set(cat, new Map());
    add(byCategory.get(cat)!, cur, amt);
    const day = e.associatedDate ?? e.date ?? "undated";
    if (!byDay.has(day)) byDay.set(day, new Map());
    add(byDay.get(day)!, cur, amt);

    const payer = payerId(e);
    if (payer !== undefined) {
      if (!paidBy.has(payer)) paidBy.set(payer, new Map());
      add(paidBy.get(payer)!, cur, amt);
      const sharers = splitIds(e);
      if (sharers.length > 0) {
        const share = amt / sharers.length;
        if (!balance.has(payer)) balance.set(payer, new Map());
        add(balance.get(payer)!, cur, amt);
        for (const id of sharers) {
          if (!balance.has(id)) balance.set(id, new Map());
          add(balance.get(id)!, cur, -share);
        }
      }
    }
  }

  const target = budget.amount;
  if (target && target.amount > 0) {
    const spent = total.get(target.currencyCode) ?? 0;
    const pct = Math.round((spent / target.amount) * 100);
    const remaining = target.amount - spent;
    out.push(
      `Target: ${target.currencyCode} ${target.amount.toLocaleString()} · spent ${target.currencyCode} ${round(spent).toLocaleString()} (${pct}%) · ${remaining >= 0 ? "remaining" : "OVER by"} ${target.currencyCode} ${round(Math.abs(remaining)).toLocaleString()}`,
    );
    const otherCur = [...total.keys()].filter((c) => c !== target.currencyCode);
    if (otherCur.length > 0) {
      out.push(`Also spent in other currencies: ${fmtMoney(new Map(otherCur.map((c) => [c, total.get(c)!])))}`);
    }
  } else {
    out.push(`Total spent: ${fmtMoney(total)} (no budget target set — use wanderlog_set_budget)`);
  }
  out.push(`${expenses.length} expense${expenses.length === 1 ? "" : "s"}${budget.simplifyDebt ? " · simplify group expenses: on" : ""}`);

  if (byCategory.size > 0) {
    out.push("", "By category:");
    for (const [cat, m] of [...byCategory.entries()].sort((a, b) => sumOf(b[1]) - sumOf(a[1]))) {
      out.push(`  ${cat}: ${fmtMoney(m)}`);
    }
  }
  if (byDay.size > 1) {
    out.push("", "By day:");
    for (const [day, m] of [...byDay.entries()].sort()) out.push(`  ${day}: ${fmtMoney(m)}`);
  }
  if (paidBy.size > 0) {
    out.push("", "Paid by:");
    for (const [id, m] of paidBy) out.push(`  ${personLabel(trip, id, selfId)}: ${fmtMoney(m)}`);
  }
  const nonZero = [...balance.entries()].filter(([, m]) => [...m.values()].some((v) => Math.abs(v) >= 0.01));
  if (nonZero.length > 0) {
    out.push("", "Balances from shared expenses (+ is owed, − owes):");
    for (const [id, m] of nonZero) {
      const parts = [...m.entries()]
        .filter(([, v]) => Math.abs(v) >= 0.01)
        .map(([c, v]) => `${v > 0 ? "+" : "−"}${c} ${round(Math.abs(v)).toLocaleString()}`);
      out.push(`  ${personLabel(trip, id, selfId)}: ${parts.join(", ")}`);
    }
  }
  return out.join("\n");
}

function sumOf(m: Money): number {
  return [...m.values()].reduce((a, b) => a + b, 0);
}

export async function budgetSummary(ctx: AppContext, args: { trip_key: string }): Promise<ToolResult> {
  try {
    const entry = await ctx.tripCache.getEntry(args.trip_key);
    return { content: [{ type: "text", text: summariseBudget(entry.snapshot, ctx.userId) }] };
  } catch (err) {
    return fail(err);
  }
}
