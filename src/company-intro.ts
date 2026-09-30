// The opening move of a new project: read the customer's OWN site and say
// back what they sell and who plausibly buys it.
//
// Cheap by construction, because it runs once per project and the value is in
// it being instant, not exhaustive: a small model, web_fetch only (fetches
// carry no per-use fee — only web_search does), and a hard cap of a few pages.
// A couple of cents versus the ~$0.70 a real search round costs.
//
// This is NOT research and must never pretend to be. It reads a homepage and
// reflects it back so the user can correct it in one sentence — getting the
// positioning wrong here is cheap and useful, because the correction is
// exactly the input the search needs.

import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { callStructured, type OnProgress, type OnUsage } from "./anthropic.js";

/** Small model on purpose — this is reading a homepage, not judging one. */
export const INTRO_MODEL = "claude-haiku-4-5";

const SYSTEM_PROMPT = `You are onboarding a new customer to a lead-research tool. Input: the URL of THEIR company. Output: a short, confident read of what they sell and who buys it — recorded via the record_intro tool.

Method:
1. web_fetch the given URL. Then fetch AT MOST two more pages from the same site that look like they explain the offer or the customer (/product, /about, /pricing, /solutions, /o-nas — adapt to the site's language).
2. Do not use web_search. Everything here comes from their own site.

Rules:
- Speak TO the company, never about them: this is read by the company themselves. Always "you" and "your" — "You sell…", "your clients…". Never "they", "their", or the company's name as the subject.
- what_they_sell: 1-2 sentences, in plain language, as a person would say it out loud. No marketing adjectives you did not read on the page.
- buyer_titles: 2-5 job titles that plausibly buy this. Infer from who the site is written FOR. Titles, not departments.
- category: the market category in 2-5 words ("AP automation software", "AI process consultancy").
- target_industries: up to 5 industries the site's customers are in — from named customers, case studies, or who the copy addresses. Leave empty rather than guess.
- target_company_size: one short phrase, under 100 characters, for the size of customer the site is built for ("small accounting firms, 1-20 staff"). Size only — no prices, plans or trial terms. Leave empty if the site doesn't say.
- target_geographies: countries or regions the site sells into — its language, currency, addresses, "available in" lists. Leave empty if unclear.
- buying_triggers: up to 4 events at a CUSTOMER company that make this product timely right now ("hiring its first finance person", "moving to e-invoicing"). Grounded in the problem the site describes, phrased as the customer's situation.
- confidence: "clear" when the site states the offer and the audience plainly; "partial" when you had to infer the audience; "unclear" when the site is vague, a holding page, or you could not read it.
- When confidence is "unclear", say what was missing in note and leave buyer_titles empty rather than guessing.
- note: at most one sentence, second person like everything else, and only when something is genuinely worth flagging (a language, a very broad offer, a site that barely loaded). Otherwise leave it out.
- Never invent a company name, a customer logo, a price or a claim. If the page does not say it, it does not go in.`;

const introInputSchema = z.object({
  company_url: z.string().url().max(2048),
  /** Anything the user already told us — respected over the site's own copy. */
  notes: z.string().max(600).optional(),
});

export type CompanyIntroInput = z.input<typeof introInputSchema>;

// These fields are shown to the seller verbatim, so an over-long one is cut
// at a word boundary and marked, never mid-word.
export function clipText(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:—–-]+$/, "")}…`;
}

const clip = (max: number) => z.string().transform((s) => clipText(s, max));

export const introToolSchema = z.object({
  company_name: clip(160),
  what_they_sell: clip(500),
  buyer_titles: z
    .array(clip(120))
    .default([])
    .transform((a) => a.slice(0, 5)),
  confidence: z.enum(["clear", "partial", "unclear"]),
  note: clip(240).optional(),
  // The rest of the seller profile, captured in the same read so the Home
  // page and the search start from real data rather than blanks.
  category: clip(160).optional(),
  target_industries: z
    .array(clip(120))
    .default([])
    .transform((a) => a.slice(0, 5)),
  target_company_size: clip(200).optional(),
  target_geographies: z
    .array(clip(120))
    .default([])
    .transform((a) => a.slice(0, 5)),
  buying_triggers: z
    .array(clip(240))
    .default([])
    .transform((a) => a.slice(0, 4)),
});

export type CompanyIntro = z.infer<typeof introToolSchema> & { company_url: string };

export interface CompanyIntroOptions {
  anthropicApiKey?: string;
  model?: string;
  onProgress?: OnProgress;
  onUsage?: OnUsage;
  signal?: AbortSignal;
}

/**
 * Read a company's site and summarise what they sell and who buys it.
 *
 * Throws on an unreadable site or a model that won't answer — the caller
 * decides whether that's worth surfacing. In the app it isn't: a project
 * still works without an intro, so the failure is swallowed there.
 */
export async function introduceCompany(
  input: CompanyIntroInput,
  opts: CompanyIntroOptions = {},
): Promise<CompanyIntro> {
  const parsed = introInputSchema.parse(input);
  const client = new Anthropic({
    apiKey: opts.anthropicApiKey ?? process.env.ANTHROPIC_API_KEY,
  });

  const userMessage = [
    `Company site: ${parsed.company_url}`,
    parsed.notes ? `What they told us: ${parsed.notes}` : "",
    ``,
    `Fetch that page (and at most two more from the same site), then record what they sell and who buys it.`,
  ]
    .filter(Boolean)
    .join("\n");

  const { output, usage } = await callStructured<unknown>({
    client,
    model: opts.model ?? INTRO_MODEL,
    systemPrompt: SYSTEM_PROMPT,
    userMessage,
    toolName: "record_intro",
    toolDescription:
      "Record what this company sells and which job titles plausibly buy it, read from their own website.",
    toolInputSchema: zodToJsonSchema(introToolSchema, {
      $refStrategy: "none",
      target: "openApi3",
    }) as Record<string, unknown>,
    cacheSystem: true,
    // No web_search: this is a read of their own site, and searches cost
    // money per use where fetches don't.
    webFetch: true,
    webFetchMaxUses: 3,
    // A homepage is not worth 15k tokens of nav and footer.
    maxContentTokens: 6000,
    maxTokens: 1024,
    onProgress: opts.onProgress,
    signal: opts.signal,
  });

  opts.onUsage?.(usage);
  return { ...introToolSchema.parse(output), company_url: parsed.company_url };
}
