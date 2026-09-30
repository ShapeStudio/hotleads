import Anthropic from "@anthropic-ai/sdk";
import { zodToJsonSchema } from "zod-to-json-schema";
import { callStructured, DEFAULT_MODEL, type OnProgress, type OnUsage } from "./anthropic.js";
import { resolveLinkedinUrls, LOOKUP_MAX_PEOPLE } from "./linkedin-lookup.js";
import type { ResearchDepth } from "./research.js";
import {
  normalizeMetaField,
  prospectSearchSchema,
  prospectSearchToolSchema,
  searchInputSchema,
  stripNulls,
  SCHEMA_VERSION,
  type ProspectSearch,
  type SearchInput,
  type SellerProfile,
} from "./schema.js";

export interface SearchProspectsOptions {
  /** Half-price Message Batches routing — minutes of latency, same output. */
  batchMode?: boolean;
  /** Defaults to process.env.ANTHROPIC_API_KEY. */
  anthropicApiKey?: string;
  /** Defaults to "claude-sonnet-5". */
  model?: string;
  /** standard = 14 web searches, deep = 18. */
  depth?: ResearchDepth;
  /** Override the search budget directly (wins over depth). */
  webSearchMaxUses?: number;
  /**
   * After the search, run a targeted pass to find LinkedIn profile URLs for
   * prospects that came back without one (default true). Costs a few extra
   * searches; makes those prospects researchable. It still never guesses a
   * URL — see linkedin-lookup.ts.
   */
  resolveLinkedinUrls?: boolean;
  onProgress?: OnProgress;
  /** Token accounting, one call per model call. Telemetry only — see anthropic.ts. */
  onUsage?: OnUsage;
  signal?: AbortSignal;
}

const SEARCH_BUDGET: Record<ResearchDepth, number> = { standard: 14, deep: 18 };

/** Direct page fetches (web_fetch) — separate from the search budget. */
const FETCH_BUDGET = 5;

const DEFAULT_COUNT = 10;

const SYSTEM_PROMPT = `You are an outbound lead-generation researcher. Input: the URL of the SELLER's own company website (plus optional target-customer description and notes). Output: the ICP (ideal customer profile) you committed to, and a list of real, verifiable decision-makers at OTHER companies who match it — recorded via the record_prospect_search tool.

The output is consumed programmatically (CRMs, outreach tooling, scripts) — completeness and honesty beat prose style. A prospect you cannot cite is a prospect you do not list.

# Inputs you may receive
- company_url (always) — the SELLER's own website. Everything starts here: read it to learn what they sell.
- target (optional) — the seller's own description of their ideal customer. When present, ADOPT it as the ICP (ground it lightly against the site, don't second-guess it) and spend the saved searches finding more people.
- seller profile (optional) — the seller's OWN confirmed description of their business: what they sell, buyer titles, industries, company size, geographies, buying triggers, and guidance. The seller has reviewed and corrected this, so it outranks anything you would infer: adopt every field as given, copy it into the icp block, infer ONLY fields it leaves empty, and follow its guidance line strictly (exclusions included).
- notes (optional seller context — factor into relevance judgments)
- Companies must be ACTIVE: when a register or news result shows a company as dissolved, de-registered, in liquidation, or otherwise defunct, skip its people entirely — a lead at a dead company is worthless to the seller.
- location (optional city-level filter) — when present, return ONLY decision-makers whose company you can place in or around that location with a cited source (HQ address, imprint, business register, office page). A candidate whose company location you cannot verify is not a match — skip them. Set each prospect's location field.
- a prospect count and a minimum number of distinct companies (in the user message)

# How to research

You have TWO server tools: web_search (search the public web) and web_fetch (retrieve a specific URL directly). web_fetch works even when a site is not indexed by any search engine — use it for every URL you were given and for pages that search snippets reference.

Use them aggressively. Plan your work (budgets shown in the user message):

1. MANDATORY FIRST STEP: web_fetch the company_url directly. The fetched page is the ground truth for what they sell — never skip this, and never substitute a search for it. If the homepage is thin, fetch 1-2 key subpages (pricing, product, about). Complement with \`site:<domain>\` search. This is the ICP foundation.
2. \`"<company>" customers OR "case study" OR testimonials\` — who already buys. Existing customers are the strongest ICP evidence; note their industries, sizes, and the buyer titles involved.
3. \`"<company>" alternatives OR competitors\` — confirm the market category and skim who the competitors sell to. Now COMMIT to an ICP: target industries, company size, geographies, and 3-6 buyer titles. Record it in the icp block. (If a seller profile or target was provided: do only search 1 for grounding, adopt the given ICP, and spend searches 2-3 on people instead.)
4. \`top <category> companies <geography>\` OR industry directories, rankings, award lists — 5-10 candidate companies that fit the ICP.
5-6. \`site:linkedin.com/in "<buyer title>" "<candidate company>"\` — direct people search. Search-engine snippets surface names, titles, and profile URLs. Repeat across candidate companies and buyer-title variants.
7. \`"<candidate company>" team OR leadership OR about\` — official team pages naming the decision-maker. Often better than LinkedIn snippets, and citable. web_fetch a team page directly when the snippet alone doesn't confirm name + role.
8. \`<industry> conference speakers <year>\` OR podcast guests — named people with verified titles and public bios.
9. \`"<candidate company>" hiring <relevant function>\` — companies hiring in the function the seller sells into are in active pain; attach as a signal.
10. \`"<candidate company>" funding OR launch OR expansion <year>\` — trigger events that make outreach timely; attach to the matching prospect's signals.
11-14. Verification passes: \`site:linkedin.com/in "<person name>"\` for each shortlisted person whose profile URL you have NOT yet seen; re-confirm the current role of anyone sourced from a page older than about a year; fill company_domain.

With a deep budget, spend the extra searches on: a second geography or vertical from the ICP, more candidate companies, and a second verification pass.

# Field rules

- icp.what_they_sell: 2-4 sentences grounded in the seller's ACTUAL site content (from the mandatory fetch) — not invented. If the fetch fails AND the domain appears in no search results, do NOT guess what the company sells from the domain name or the market context: record only what you verified, set meta.confidence to "low", explain the failure in meta.research_notes, and return few or zero prospects rather than prospects matched to a guessed ICP.
- icp.buyer_titles: the titles that actually buy this product.
- prospects[].linkedin_url: ONLY a linkedin.com/in/… URL that literally appeared in a search result you retrieved for THIS person. NEVER construct a slug from a name. No URL observed → leave the field empty; the prospect is still valid.
- prospects[].source_url is REQUIRED — the page where you saw this person's name AND role. If you cannot cite one, do not list the person.
- prospects[].why_relevant must reference the ICP ("VP Ops at a 200-person DACH logistics firm — matches the mid-market ops ICP"), not generic flattery.
- prospects[].confidence: high = role verified on 2+ pages or a current official page; medium = single credible source; low = single dated or indirect source. Do not list anyone you would rate below low.
- Spread prospects across DISTINCT companies — ten people at one company is a worse list than ten companies with one person each.
- The seller needs a DIRECT channel to each person (LinkedIn message, direct email, direct line). All else equal, prefer decision-makers with an observable public presence — a profile URL that appeared in results, or published direct contact details — over people visible only on a stale third-party page.
- Do not list people at the seller's own company or at its direct competitors.
- meta.sources: every page that informed the list (up to 15). Real URLs you retrieved via web_search only.
- meta.research_notes: 1-3 sentences on ICP confidence and what was hard to find. If you return fewer prospects than asked, say why here.

# Rules
- Write all output field values in English, regardless of the website's language. Keep proper nouns as-is and local role titles alongside English (e.g. "Director (direktor)") where they help outreach.
- Prefer 8 verified prospects over 15 guessed ones. Fewer than requested is fine.
- Do not fabricate people, titles, or URLs. Every prospect must be traceable to a page you actually retrieved.
- Distinguish what you read from what you inferred.
- Output ONLY via the record_prospect_search tool — no prose response.`;

const toolInputSchema = zodToJsonSchema(prospectSearchToolSchema, {
  $refStrategy: "none",
  target: "openApi3",
}) as Record<string, unknown>;

/**
 * Find prospects for a company: reads what the company at input.company_url
 * sells, commits to an ICP (or adopts input.target), and returns cited
 * decision-makers at other companies who match it. Resolves to the full
 * structured result; throws on invalid input, missing API key, or
 * model/API failure.
 */
/**
 * Render a seller profile as the prompt block the search adopts as its ICP.
 * Returns "" when nothing in it is filled, so an empty profile never produces
 * a heading with nothing under it (and never flips icp_source to "provided").
 */
export function formatSellerProfile(profile: SellerProfile): string {
  const list = (items?: string[]) =>
    items?.map((i) => i.trim()).filter(Boolean).join("; ") || "";
  const lines = [
    profile.what_they_sell?.trim() && `What they sell: ${profile.what_they_sell.trim()}`,
    profile.category?.trim() && `Category: ${profile.category.trim()}`,
    list(profile.buyer_titles) && `Buyer titles (who to find): ${list(profile.buyer_titles)}`,
    list(profile.target_industries) && `Target industries: ${list(profile.target_industries)}`,
    profile.target_company_size?.trim() && `Target company size: ${profile.target_company_size.trim()}`,
    list(profile.target_geographies) && `Target geographies: ${list(profile.target_geographies)}`,
    list(profile.buying_triggers) && `Buying triggers (timely signals): ${list(profile.buying_triggers)}`,
    profile.notes?.trim() && `Seller's guidance: ${profile.notes.trim()}`,
  ].filter(Boolean);
  return lines.join("\n");
}

export async function searchProspects(
  input: SearchInput,
  opts: SearchProspectsOptions = {},
): Promise<ProspectSearch> {
  const parsedInput = searchInputSchema.parse(input);

  const apiKey = opts.anthropicApiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      "Missing Anthropic API key. Set ANTHROPIC_API_KEY (get one at https://console.anthropic.com) or pass opts.anthropicApiKey.",
    );
  }
  const model = opts.model ?? DEFAULT_MODEL;
  const depth: ResearchDepth = opts.depth ?? "standard";
  const count = parsedInput.count ?? DEFAULT_COUNT;
  // A round asked for 3 leads doesn't need the full 14-search budget. The
  // floor (7 + count) always leaves room for the ICP work (searches 1-3)
  // and the verification passes — those are quality, never cut them.
  const searchBudget =
    opts.webSearchMaxUses ?? Math.min(SEARCH_BUDGET[depth], 7 + count);
  const minCompanies = Math.min(Math.ceil(count / 2), 5);

  const client = new Anthropic({ apiKey });

  const userMessage = [
    `# Seller`,
    `Company website (canonical — the ICP starts here): ${parsedInput.company_url}`,
    parsedInput.profile && formatSellerProfile(parsedInput.profile)
      ? `\n# Seller profile (confirmed by the seller — adopt as the ICP; do NOT re-infer these from the website, only fill what's missing)\n${formatSellerProfile(parsedInput.profile)}`
      : null,
    parsedInput.target
      ? `\n# Target customer (provided by the seller — adopt as the ICP)\n${parsedInput.target}`
      : null,
    parsedInput.notes ? `\n# Seller notes\n${parsedInput.notes}` : null,
    parsedInput.location
      ? `\n# Location filter (city-level)\nOnly decision-makers whose company is in or around: ${parsedInput.location}. Verify each one's location with a cited source; skip anyone you can't place there.`
      : null,
    parsedInput.exclude?.length
      ? `\n# Already known — do NOT return these people (find others, ideally at other companies)\n${parsedInput.exclude.map((p) => `- ${p}`).join("\n")}`
      : null,
    `\nFind up to ${count} prospects across at least ${minCompanies} distinct companies.`,
    `Budgets: up to ${searchBudget} web searches and up to ${FETCH_BUDGET} direct page fetches. Fetch the company website first, research deeply, and call record_prospect_search with the ICP and every prospect you can cite.`,
  ]
    .filter(Boolean)
    .join("\n");

  const { output, searchesUsed, fetchesUsed, usage } = await callStructured<unknown>({
    client,
    model,
    systemPrompt: SYSTEM_PROMPT,
    userMessage,
    toolName: "record_prospect_search",
    toolDescription:
      "Record the structured prospect search: the ICP committed to, the list of cited prospects, and meta/provenance.",
    toolInputSchema,
    cacheSystem: true,
    webSearch: true,
    webSearchMaxUses: searchBudget,
    webFetch: true,
    webFetchMaxUses: FETCH_BUDGET,
    maxTokens: 8192,
    onProgress: opts.onProgress,
    signal: opts.signal,
    batch: opts.batchMode,
    // Nobody is watching a batch round — wait out a slow queue instead of
    // canceling at 10 min and re-paying full price on the live API.
    batchWaitMs: opts.batchMode ? 35 * 60_000 : undefined,
  });

  // Report spend before parsing: the tokens are already bought whether or
  // not the output validates.
  opts.onUsage?.(usage);

  // Models emit explicit nulls for unfillable optional fields — strip them
  // before validation (see stripNulls docs) — and occasionally emit meta as
  // a prose string (see normalizeMetaField docs).
  const parsed = prospectSearchToolSchema.parse(normalizeMetaField(stripNulls(output)));

  // Prospects sourced from team pages, registers, or conference listings
  // often arrive without a profile URL. One targeted pass fills in the ones
  // that are actually findable — it never guesses (see linkedin-lookup.ts).
  let lookupSearches = 0;
  if (opts.resolveLinkedinUrls !== false) {
    const missing = parsed.prospects
      .map((prospect, index) => ({ prospect, index }))
      .filter(({ prospect }) => !prospect.linkedin_url)
      .slice(0, LOOKUP_MAX_PEOPLE);

    if (missing.length > 0) {
      const { urls, searchesUsed: used } = await resolveLinkedinUrls(
        missing.map(({ prospect }) => ({
          full_name: prospect.full_name,
          company: prospect.company,
          title: prospect.title,
        })),
        {
          client,
          // Deliberately NOT the search model: URL backfill is pure snippet
          // extraction, and linkedin-lookup's own Haiku default does it at a
          // third of the token price. Passing `model` here silently routed
          // this pass through Sonnet for months.
          onProgress: opts.onProgress,
          // Fires again — a round that backfills LinkedIn URLs is two model
          // calls, and the caller should see both.
          onUsage: opts.onUsage,
          signal: opts.signal,
        },
      );
      lookupSearches = used;
      urls.forEach((url, i) => {
        const target = missing[i];
        if (url && target) parsed.prospects[target.index]!.linkedin_url = url;
      });
    }
  }

  // Code-filled fields — never trusted to the model.
  const result: ProspectSearch = {
    ...parsed,
    icp: {
      ...parsed.icp,
      icp_source:
        parsedInput.target || (parsedInput.profile && formatSellerProfile(parsedInput.profile))
          ? "provided"
          : "inferred",
    },
    meta: {
      ...(parsed.meta ?? {}),
      searched_at: new Date().toISOString(),
      model,
      searches_used: searchesUsed + lookupSearches,
      fetches_used: fetchesUsed,
      schema_version: SCHEMA_VERSION,
    },
  };

  return prospectSearchSchema.parse(result);
}
