// Targeted LinkedIn profile-URL resolution.
//
// Prospect search deliberately leaves linkedin_url empty when no profile URL
// appeared in the results it retrieved — a person named on a company team
// page or in a business register is a perfectly good prospect, and guessing
// a slug from their name produces dead links. This module closes the gap
// honestly: one cheap targeted pass that asks ONLY "does a profile URL for
// this exact person exist in search results?", still refusing to construct
// one. Prospects that come back empty here stay empty.
//
// Runs automatically at the end of searchProspects (opt out with
// resolveLinkedinUrls: false).

import Anthropic from "@anthropic-ai/sdk";
import { zodToJsonSchema } from "zod-to-json-schema";
import { z } from "zod";
import { callStructured, type OnProgress, type OnUsage } from "./anthropic.js";

/** People per lookup pass — bounds cost and keeps the prompt small. */
export const LOOKUP_MAX_PEOPLE = 10;

export type LookupPerson = {
  full_name: string;
  company: string;
  title?: string | null;
};

const lookupToolSchema = z.object({
  results: z
    .array(
      z.object({
        /** Index into the numbered list from the user message. */
        index: z.number().int().min(0),
        /** Omit entirely when no profile URL was actually observed. */
        linkedin_url: z.string().max(2048).optional(),
      }),
    )
    .max(LOOKUP_MAX_PEOPLE),
});

export { lookupToolSchema };

const toolInputSchema = zodToJsonSchema(lookupToolSchema, {
  $refStrategy: "none",
  target: "openApi3",
}) as Record<string, unknown>;

const SYSTEM_PROMPT = `You resolve LinkedIn profile URLs for people who have already been identified by name, title, and company. You are not evaluating or researching them — you only find their profile URL if it exists in public search results.

# How to search
For each person, run one targeted search (a second only if the first is ambiguous):
  site:linkedin.com/in "<full name>" "<company>"
If that returns nothing useful, one variation is allowed — the person's name plus their title, or their name plus a distinctive company keyword.

# Rules
- Return a linkedin_url ONLY when a linkedin.com/in/… URL for THAT person literally appeared in a result you retrieved, and the surrounding snippet matches their name AND their company or title.
- NEVER construct, guess, complete, or pattern-match a profile slug from someone's name. A wrong URL is far worse than no URL.
- Common names are a trap: if you cannot tell which of several people is the right one, omit the URL.
- Omitting a URL is a normal, correct outcome — many people simply have no findable public profile. Do not stretch to fill every row.
- Never return a linkedin.com/company/… URL, a directory page, or a post URL — profile URLs only.
- Report every person's index exactly once, in the order given, via the record_profile_urls tool. No prose response.`;

/** Same guard as the prospect schema: only well-formed /in/ profile URLs. */
function cleanProfileUrl(url: string | undefined): string | undefined {
  return url &&
    url.length <= 2048 &&
    /^https?:\/\/([^/\s]+\.)?linkedin\.com\/in\/./i.test(url)
    ? url
    : undefined;
}

/**
 * Look up LinkedIn profile URLs for the given people. Resolves to an array
 * aligned with `people` — each entry is the profile URL or undefined.
 * Never throws: a failed lookup degrades to "no URLs found", because this
 * is an enrichment pass and must not sink the search that produced them.
 */
export async function resolveLinkedinUrls(
  people: LookupPerson[],
  opts: {
    client: Anthropic;
    model?: string;
    onProgress?: OnProgress;
    onUsage?: OnUsage;
    signal?: AbortSignal;
  },
): Promise<{ urls: (string | undefined)[]; searchesUsed: number }> {
  const batch = people.slice(0, LOOKUP_MAX_PEOPLE);
  if (batch.length === 0) return { urls: [], searchesUsed: 0 };

  const userMessage = [
    `Find the LinkedIn profile URL for each person below. Report every index, omitting linkedin_url where you did not observe one.`,
    ``,
    ...batch.map((p, i) =>
      `${i}. ${p.full_name}${p.title ? ` — ${p.title}` : ""} at ${p.company}`,
    ),
    ``,
    `Search budget: up to ${batch.length + 2} web searches total.`,
  ].join("\n");

  try {
    const { output, searchesUsed, usage } = await callStructured<unknown>({
      client: opts.client,
      // Profile-URL lookup is pure extraction — the small model does it
      // at a third of the token price.
      model: opts.model ?? "claude-haiku-4-5",
      systemPrompt: SYSTEM_PROMPT,
      userMessage,
      toolName: "record_profile_urls",
      toolDescription:
        "Record the LinkedIn profile URL found for each person, omitting the URL for anyone whose profile was not observed in search results.",
      toolInputSchema,
      cacheSystem: true,
      webSearch: true,
      webSearchMaxUses: batch.length + 2,
      maxTokens: 1024,
      // Only forward search/fetch ticks — start/done belong to the caller's run.
      onProgress: opts.onProgress
        ? (e) => {
            if (e.type === "search" || e.type === "fetch") opts.onProgress?.(e);
          }
        : undefined,
      signal: opts.signal,
    });

    opts.onUsage?.(usage);

    const parsed = lookupToolSchema.safeParse(output);
    const urls: (string | undefined)[] = new Array(batch.length).fill(undefined);
    if (parsed.success) {
      for (const row of parsed.data.results) {
        if (row.index >= 0 && row.index < batch.length) {
          urls[row.index] = cleanProfileUrl(row.linkedin_url);
        }
      }
    }
    return { urls, searchesUsed };
  } catch {
    // Enrichment must never fail the search that produced these people.
    return { urls: new Array(batch.length).fill(undefined), searchesUsed: 0 };
  }
}
