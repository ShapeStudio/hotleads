// Second-best-person lookup: when the lead you wanted at a company turns out
// to be a dead end — departed, member-gated profile, nothing published but a
// team@ inbox — this pass finds OTHER decision-makers at that SAME company
// who are actually reachable. Reachability is the admission ticket: a person
// only makes the list with an observed LinkedIn profile URL or a published
// direct email/phone tied to them by name. Same honesty contract as the rest
// of the engine: cited or absent, never guessed.

import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { callStructured, DEFAULT_MODEL, type OnProgress, type OnUsage } from "./anthropic.js";
import { contactItemSchema, stripNulls, truncate } from "./schema.js";

/** Results per pass — one company only ever needs a handful of ways in. */
export const ALTERNATE_MAX_RESULTS = 5;

const SEARCH_BUDGET = 8;
const FETCH_BUDGET = 5;

const SYSTEM_PROMPT = `You are an outbound lead researcher on a targeted rescue pass. Input: ONE company, the people there who are already known (and off the table), and optionally the buyer titles the seller cares about. Output: OTHER decision-makers currently at that company who are directly REACHABLE — recorded via the record_alternates tool.

Why you exist: the seller's first-choice person at this company was a dead end (left the company, member-gated profile, or only a team@ inbox published). Your job is the next-best person they can actually message today.

# The reachability gate (the whole point)
List a person ONLY when at least one of these is true, from pages you actually retrieved:
- a linkedin.com/in/… profile URL for THAT person literally appeared in a search result whose snippet matches their name AND this company, OR
- a page you read publishes a DIRECT email or DIRECT phone tied to them by name (imprint, team page, register entry, talk bio, press release).
A person with neither is not a result, however senior. Record what qualified them: the profile URL and/or the contact items with source_url and reach: "direct".

# How to search
1. web_fetch the company site's team / about / contact / imprint pages (adapt paths to the site's language) — names, titles, and direct details live there and are often not in search snippets.
2. site:linkedin.com/in "<company>" "<buyer title>" — repeat across the given titles, then across adjacent senior titles (founders, MDs, heads of the relevant function).
3. Business registers and directories for directors/officers; recent press releases and conference bios for named spokespeople.

# Rules
- CURRENT employees only: confirm from the company's own current pages or a recent (this/last year) source. Someone who has left does not count — that failure is why you were called.
- The excluded people are off the table entirely — do not re-list them under any spelling.
- Rank by fit to the given buyer titles first, then seniority: the best alternate owns the same problem the original target did.
- why_pick: one or two sentences — their role's relevance AND which channel makes them reachable.
- NEVER construct a profile slug or an email from a name pattern. Cited or absent.
- source_url is REQUIRED per person: the page where you saw their name AND current role.
- confidence: high = role verified on a current official page or 2+ sources; medium = single credible source; low = do not list them.
- An empty list is a legitimate result when nobody qualifies — say why in note.
- Output ONLY via the record_alternates tool — no prose response.`;

const alternateLookupInputSchema = z.object({
  /** Company name as saved on the failed lead. */
  company: z.string().min(1).max(160),
  /** Bare domain when known (e.g. "acme.com") — enables direct fetches. */
  company_domain: z.string().max(160).optional(),
  /** People already known at this company — the failed lead and any saved ones. */
  exclude: z
    .array(z.object({ full_name: z.string().max(120), title: z.string().max(160).optional() }))
    .max(30)
    .default([]),
  /** Buyer titles the seller targets — ranks the alternates. */
  prefer_titles: z.array(z.string().max(120)).max(8).optional(),
  /** Seller context (what they sell / why this company) — sharpens fit. */
  context: z.string().max(600).optional(),
  /** Alternates wanted. Default 3, cap 5. */
  count: z.number().int().min(1).max(ALTERNATE_MAX_RESULTS).optional(),
});

export type AlternateLookupInput = z.input<typeof alternateLookupInputSchema>;

const clip = (max: number) => z.string().min(1).transform((s) => truncate(s, max));
const clipOpt = (max: number) => z.string().transform((s) => truncate(s, max));

/** Same guard as the prospect schema: only well-formed /in/ profile URLs survive. */
const profileUrl = z
  .string()
  .optional()
  .transform((u) =>
    u && u.length <= 2048 && /^https?:\/\/([^/\s]+\.)?linkedin\.com\/in\/./i.test(u)
      ? u
      : undefined,
  );

export const alternateProspectSchema = z.object({
  full_name: clip(120),
  title: clip(160),
  /** "C-level", "VP", "Director", … */
  seniority: clipOpt(60).optional(),
  /** Only when the URL literally appeared in a retrieved result — never constructed. */
  linkedin_url: profileUrl,
  /** REQUIRED: the page where this person's name AND current role were seen. */
  source_url: z.string().url().max(2048),
  /** Role relevance + which channel makes them reachable. */
  why_pick: clip(400),
  confidence: z.enum(["high", "medium", "low"]),
  /** Published DIRECT details tied to this person (reach: "direct"). */
  emails: z.array(contactItemSchema).optional().transform((a) => a?.slice(0, 3)),
  phones: z.array(contactItemSchema).optional().transform((a) => a?.slice(0, 3)),
});

export const alternateLookupToolSchema = z.object({
  alternates: z
    .array(alternateProspectSchema)
    .transform((a) => a.slice(0, ALTERNATE_MAX_RESULTS)),
  /** Why the list is short/empty, or the best route in when nobody qualifies. */
  note: clipOpt(400).optional(),
});

export type AlternateProspect = z.infer<typeof alternateProspectSchema>;
export type AlternateLookupResult = z.infer<typeof alternateLookupToolSchema> & {
  searchesUsed: number;
  fetchesUsed: number;
};

export interface AlternateLookupOptions {
  anthropicApiKey?: string;
  /** Defaults to "claude-sonnet-5" — picking the right person needs judgment. */
  model?: string;
  onProgress?: OnProgress;
  /** Token accounting, one call per model call. Telemetry only — see anthropic.ts. */
  onUsage?: OnUsage;
  signal?: AbortSignal;
}

const toolInputSchema = zodToJsonSchema(alternateLookupToolSchema, {
  $refStrategy: "none",
  target: "openApi3",
}) as Record<string, unknown>;

/**
 * Find reachable alternate decision-makers at one company, excluding the
 * people already known there. Resolves to the (possibly empty) ranked list;
 * throws on invalid input, missing API key, or model/API failure.
 */
export async function findAlternateContacts(
  input: AlternateLookupInput,
  opts: AlternateLookupOptions = {},
): Promise<AlternateLookupResult> {
  const parsed = alternateLookupInputSchema.parse(input);
  const apiKey = opts.anthropicApiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      "Missing Anthropic API key. Set ANTHROPIC_API_KEY (get one at https://console.anthropic.com) or pass opts.anthropicApiKey.",
    );
  }
  const count = parsed.count ?? 3;

  const userMessage = [
    `# Company`,
    `Name: ${parsed.company}`,
    parsed.company_domain ? `Domain: ${parsed.company_domain}` : null,
    parsed.exclude.length > 0
      ? `\n# Already known at this company — OFF the table\n${parsed.exclude
          .map((p) => `- ${p.full_name}${p.title ? ` (${p.title})` : ""}`)
          .join("\n")}`
      : null,
    parsed.prefer_titles?.length
      ? `\n# Buyer titles the seller targets (rank by fit to these)\n${parsed.prefer_titles
          .map((t) => `- ${t}`)
          .join("\n")}`
      : null,
    parsed.context ? `\n# Seller context\n${parsed.context}` : null,
    `\nFind up to ${count} reachable alternates.`,
    `Budgets: up to ${SEARCH_BUDGET} web searches and up to ${FETCH_BUDGET} direct page fetches. Fetch the team/imprint pages first, then call record_alternates.`,
  ]
    .filter(Boolean)
    .join("\n");

  const { output, searchesUsed, fetchesUsed, usage } = await callStructured<unknown>({
    client: new Anthropic({ apiKey }),
    model: opts.model ?? DEFAULT_MODEL,
    systemPrompt: SYSTEM_PROMPT,
    userMessage,
    toolName: "record_alternates",
    toolDescription:
      "Record the reachable alternate decision-makers found at this company: each with name, current title, the source page, what makes them reachable, and any published direct contact details.",
    toolInputSchema,
    cacheSystem: true,
    webSearch: true,
    webSearchMaxUses: SEARCH_BUDGET,
    webFetch: true,
    webFetchMaxUses: FETCH_BUDGET,
    // Team/imprint pages don't need the default 15k-token fetch cap, and this
    // pass runs on the big model where re-billed fetch tokens actually hurt.
    maxContentTokens: 8000,
    maxTokens: 3000,
    onProgress: opts.onProgress,
    signal: opts.signal,
  });

  opts.onUsage?.(usage);

  // Models emit explicit nulls for unfillable optional fields — strip them
  // before validation (see stripNulls docs in schema.ts).
  const result = alternateLookupToolSchema.parse(stripNulls(output));
  return { ...result, searchesUsed, fetchesUsed };
}
