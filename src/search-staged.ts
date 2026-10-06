// Staged prospect search: plan, fan out per company, merge.
//
// The single-call search (search.ts) asks one model to commit an ICP, pick
// companies, find people at each, verify them and write the list — around 19
// serial tool turns with thinking between each. This module splits that into
// a short planning call that commits the ICP and names candidate companies,
// then one narrow people-finding call PER COMPANY, all running at once, then
// a merge in code. The wall-clock is the plan plus the slowest company, the
// first leads exist as soon as the first company returns, and asking for 25
// leads costs the same time as asking for 10.
//
// Same input and output contract as searchProspects, so callers can switch.

import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import {
  callStructured,
  DEFAULT_MODEL,
  type CallUsage,
  type EffortLevel,
  type OnProgress,
  type OnUsage,
} from "./anthropic.js";
import { resolveLinkedinUrls, LOOKUP_MAX_PEOPLE } from "./linkedin-lookup.js";
import { plausibleProfileUrl } from "./profile-url.js";
import { formatSellerProfile } from "./search.js";
import {
  icpSchema,
  normalizeMetaField,
  prospectLeadSchema,
  prospectSearchSchema,
  searchInputSchema,
  stripNulls,
  SCHEMA_VERSION,
  type IcpProfile,
  type ProspectLead,
  type ProspectSearch,
  type SearchInput,
} from "./schema.js";

export interface StagedSearchOptions {
  /** Defaults to process.env.ANTHROPIC_API_KEY. */
  anthropicApiKey?: string;
  /** Defaults to "claude-sonnet-5" for both stages. */
  model?: string;
  /** Default "medium" — the measured sweet spot for these tool loops. */
  effort?: EffortLevel;
  /** Default "direct" — the filtering sandbox is pure latency here. */
  webToolCalling?: "filtered" | "direct";
  /** Per-company calls in flight at once. Default 6. */
  concurrency?: number;
  /** Companies the planner should name. Default derives from `count`. */
  candidateCount?: number;
  /** Haiku pass that backfills missing LinkedIn URLs (default true). */
  resolveLinkedinUrls?: boolean;
  /**
   * Fires as each company's people land, before the merge — the hook for
   * showing leads while the slower companies are still being searched.
   * The prospects are already sanitised (URL guard, exclusions applied)
   * but not yet deduplicated against other companies or trimmed to count.
   */
  onCompany?: (company: string, prospects: ProspectLead[]) => void;
  onProgress?: OnProgress;
  onUsage?: OnUsage;
  signal?: AbortSignal;
}

const DEFAULT_COUNT = 10;
const DEFAULT_CONCURRENCY = 6;
/** Per-company budgets: a people search is a narrow task. */
const PEOPLE_SEARCH_BUDGET = 3;
const PEOPLE_FETCH_BUDGET = 1;
const MAX_PER_COMPANY = 3;

// ---- stage 1: plan ---------------------------------------------------------

export const searchPlanToolSchema = z.object({
  icp: icpSchema,
  candidates: z
    .array(
      z.object({
        company: z.string().min(1).max(160),
        /** Root domain when seen — lets the people stage search site: pages. */
        company_domain: z.string().max(240).optional(),
        /** One sentence tying the company to the ICP. */
        why_fit: z.string().min(1).max(300),
        /** Where the company was seen (directory, ranking, customer page …). */
        source_url: z.string().url().max(2048),
        location: z.string().max(120).optional(),
      }),
    )
    .max(12),
  research_notes: z.string().max(600).optional(),
});

const planToolInputSchema = zodToJsonSchema(searchPlanToolSchema, {
  $refStrategy: "none",
  target: "openApi3",
}) as Record<string, unknown>;

const PLAN_SYSTEM_PROMPT = `You are the PLANNING stage of an outbound lead-generation researcher. Input: the SELLER's company website, plus an optional seller profile or target-customer description, and notes. Output, via the record_search_plan tool: the ICP (ideal customer profile) you commit to, and a list of candidate COMPANIES that match it. You do NOT look for people — a separate stage searches each company you name.

# ICP
- If a seller profile or target is given, it IS the ICP: adopt every field, infer only what it leaves empty, follow its guidance line strictly (exclusions included). Do not fetch or search the seller's own site in that case.
- Otherwise: web_fetch the company_url first (ground truth for what they sell; fetch one key subpage if the homepage is thin), then search \`"<company>" customers OR "case study"\` and \`"<company>" alternatives OR competitors\`, and commit to target industries, company size, geographies and 3-6 buyer titles.

# Candidate companies
Spend the rest of the budget finding companies, not people: \`top <category> companies <geography>\`, industry directories and rankings, award lists, customers of competitors, \`<industry> companies hiring <function the seller sells into>\`, funding and expansion news in the target geographies.
- Return the number of companies asked for, each DISTINCT, ACTIVE (skip anything dissolved, in liquidation or defunct), matching the ICP's industry, size and geography, and NOT the seller or its direct competitors.
- Prefer companies with a visible leadership or team presence (public team page, named executives in news) — the next stage must find and cite a real decision-maker there.
- Every candidate needs source_url: the page where you saw the company. Set company_domain when a result shows it.
- When a list of already-mined companies is given, prefer others; include one of them only if it is clearly large enough to hold more matching buyers.
- When a location filter is given, only companies you can place in or around it with a cited source.

# Rules
- All output in English; keep proper nouns as-is.
- Do not fabricate companies or URLs. Do not narrate between tool calls.
- Output ONLY via record_search_plan.`;

// ---- stage 2: people at one company ----------------------------------------

export const companyPeopleToolSchema = z.object({
  company_domain: z.string().max(240).optional(),
  prospects: z.array(prospectLeadSchema).max(5),
  notes: z.string().max(300).optional(),
});

const peopleToolInputSchema = zodToJsonSchema(companyPeopleToolSchema, {
  $refStrategy: "none",
  target: "openApi3",
}) as Record<string, unknown>;

const PEOPLE_SYSTEM_PROMPT = `You find decision-makers at ONE named company for an outbound seller. Input: the seller's ICP (what they sell, the buyer titles that purchase it), the company, how many people are wanted, and names already known. Output, via the record_company_people tool: real, citable people at that company who hold one of the buyer titles (or the closest equivalent), most senior first.

# How to search (small budget — be direct)
1. \`site:linkedin.com/in "<company>" "<buyer title>"\` — combine two titles with OR in one query. Snippets surface names, titles and profile URLs.
2. \`"<company>" team OR leadership OR management\` — the official page naming executives; web_fetch it when a snippet does not confirm name AND current role.
3. Only if budget remains: \`"<company>" hiring OR funding OR expansion <year>\` for a timely signal to attach.

# Rules
- source_url is REQUIRED per person: the page where you saw the name AND the role. No citable page, no person.
- linkedin_url ONLY when a linkedin.com/in/… URL for THAT person literally appeared in a result you retrieved. NEVER build a slug from a name. Leave it empty otherwise — the person is still valid.
- confidence: high = role verified on 2+ pages or a current official page; medium = one credible source; low = one dated or indirect source. List nobody below low.
- why_relevant ties the person to the ICP (title + why this company fits) in one sentence.
- Skip anyone in the already-known list. Skip people who have left the company.
- Fewer than asked, or none, is a correct answer. Do not pad with juniors or guesses.
- Write in English; keep proper nouns as-is. Do not narrate between tool calls.
- Output ONLY via record_company_people.`;

// ---- helpers ---------------------------------------------------------------

type Candidate = z.infer<typeof searchPlanToolSchema>["candidates"][number];

/** "Name (Company)" strings → the names and companies they mention. */
export function parseExcluded(exclude: string[] | undefined): {
  names: Set<string>;
  companies: Set<string>;
} {
  const names = new Set<string>();
  const companies = new Set<string>();
  for (const entry of exclude ?? []) {
    const m = entry.match(/^(.*?)\s*\(([^)]*)\)\s*$/);
    if (m) {
      names.add(fold(m[1]!));
      if (m[2]!.trim()) companies.add(fold(m[2]!));
    } else {
      names.add(fold(entry));
    }
  }
  return { names, companies };
}

const fold = (s: string) => s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();

/**
 * Interleave per-company results so the first N picks span as many
 * companies as possible (ten companies with one person each beats one
 * company with ten), dedupe by name+company, and trim to `count`.
 */
export function mergeCompanyResults(
  perCompany: ProspectLead[][],
  count: number,
): ProspectLead[] {
  const seen = new Set<string>();
  const out: ProspectLead[] = [];
  const queues = perCompany.map((list) => [...list]);
  let progressed = true;
  while (out.length < count && progressed) {
    progressed = false;
    for (const queue of queues) {
      const lead = queue.shift();
      if (!lead) continue;
      progressed = true;
      const key = `${fold(lead.full_name)}|${fold(lead.company)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(lead);
      if (out.length >= count) break;
    }
  }
  return out;
}

async function mapPool<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i] as T, i);
      }
    }),
  );
  return out;
}

// ---- orchestration ---------------------------------------------------------

export async function searchProspectsStaged(
  input: SearchInput,
  opts: StagedSearchOptions = {},
): Promise<ProspectSearch> {
  const parsedInput = searchInputSchema.parse(input);
  const apiKey = opts.anthropicApiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      "Missing Anthropic API key. Set ANTHROPIC_API_KEY (get one at https://console.anthropic.com) or pass opts.anthropicApiKey.",
    );
  }
  const model = opts.model ?? DEFAULT_MODEL;
  const effort = opts.effort ?? "medium";
  const webToolCalling = opts.webToolCalling ?? "direct";
  const client = new Anthropic({ apiKey });
  const count = parsedInput.count ?? DEFAULT_COUNT;
  // Enough companies that one or two dry ones don't sink the round, but not
  // so many that the plan call spends its budget listing rather than vetting.
  const candidateCount = Math.min(
    12,
    Math.max(5, opts.candidateCount ?? Math.ceil(count * 0.8) + 2),
  );
  const perCompany = Math.min(MAX_PER_COMPANY, Math.max(1, Math.ceil(count / candidateCount) + 1));
  const excluded = parseExcluded(parsedInput.exclude);

  const profileBlock = parsedInput.profile ? formatSellerProfile(parsedInput.profile) : "";
  const hasIcp = Boolean(profileBlock || parsedInput.target);

  let searchesUsed = 0;
  let fetchesUsed = 0;
  const spend = (u: CallUsage) => opts.onUsage?.(u);

  // ---- stage 1 ----
  const planMessage = [
    `# Seller`,
    `Company website: ${parsedInput.company_url}`,
    profileBlock
      ? `\n# Seller profile (confirmed by the seller — adopt as the ICP; do NOT re-infer from the website, only fill what's missing)\n${profileBlock}`
      : null,
    parsedInput.target
      ? `\n# Target customer (provided by the seller — adopt as the ICP)\n${parsedInput.target}`
      : null,
    parsedInput.notes ? `\n# Seller notes\n${parsedInput.notes}` : null,
    parsedInput.location
      ? `\n# Location filter (city-level)\nOnly companies you can place in or around: ${parsedInput.location}, with a cited source.`
      : null,
    excluded.companies.size > 0
      ? `\n# Companies already mined — prefer others\n${[...excluded.companies].slice(0, 40).map((c) => `- ${c}`).join("\n")}`
      : null,
    `\nName ${candidateCount} candidate companies. Budget: up to ${hasIcp ? 4 : 6} web searches${hasIcp ? "" : " and up to 2 direct page fetches (the seller site first)"}. Then call record_search_plan.`,
  ]
    .filter(Boolean)
    .join("\n");

  const plan = await callStructured<unknown>({
    client,
    model,
    systemPrompt: PLAN_SYSTEM_PROMPT,
    userMessage: planMessage,
    toolName: "record_search_plan",
    toolDescription: "Record the ICP committed to and the candidate companies to search for decision-makers.",
    toolInputSchema: planToolInputSchema,
    cacheSystem: true,
    webSearch: true,
    webSearchMaxUses: hasIcp ? 4 : 6,
    webFetch: !hasIcp,
    webFetchMaxUses: 2,
    maxContentTokens: 6000,
    maxTokens: 8192,
    effort,
    webToolCalling,
    onProgress: opts.onProgress,
    signal: opts.signal,
  });
  spend(plan.usage);
  searchesUsed += plan.searchesUsed;
  fetchesUsed += plan.fetchesUsed;
  const parsedPlan = searchPlanToolSchema.parse(stripNulls(plan.output));
  const icp: IcpProfile = { ...parsedPlan.icp, icp_source: hasIcp ? "provided" : "inferred" };
  const candidates = parsedPlan.candidates.slice(0, candidateCount);

  // ---- stage 2 ----
  const icpBlock = [
    `What the seller sells: ${icp.what_they_sell}`,
    icp.category ? `Category: ${icp.category}` : null,
    `Buyer titles (who to find): ${icp.buyer_titles.join("; ")}`,
    icp.target_industries?.length ? `Target industries: ${icp.target_industries.join("; ")}` : null,
    icp.target_company_size ? `Target company size: ${icp.target_company_size}` : null,
    icp.buying_triggers?.length ? `Buying triggers: ${icp.buying_triggers.join("; ")}` : null,
    parsedInput.profile?.notes ? `Seller's guidance: ${parsedInput.profile.notes}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  const perCompanyResults = await mapPool(
    candidates,
    opts.concurrency ?? DEFAULT_CONCURRENCY,
    async (candidate: Candidate): Promise<{ candidate: Candidate; prospects: ProspectLead[]; notes?: string }> => {
      if (opts.signal?.aborted) return { candidate, prospects: [] };
      const knownHere = (parsedInput.exclude ?? [])
        .filter((e) => fold(e).includes(fold(candidate.company)))
        .map((e) => e.replace(/\s*\([^)]*\)\s*$/, ""))
        .slice(0, 20);
      const userMessage = [
        `# Seller ICP\n${icpBlock}`,
        `\n# Company to search\n${candidate.company}${candidate.company_domain ? ` (${candidate.company_domain})` : ""}${candidate.location ? ` — ${candidate.location}` : ""}\nWhy it fits: ${candidate.why_fit}`,
        knownHere.length > 0 ? `\n# Already known at this company — find OTHERS\n${knownHere.map((n) => `- ${n}`).join("\n")}` : null,
        `\nFind up to ${perCompany} decision-maker${perCompany === 1 ? "" : "s"}. Budget: up to ${PEOPLE_SEARCH_BUDGET} web searches and ${PEOPLE_FETCH_BUDGET} direct page fetch. Then call record_company_people.`,
      ]
        .filter(Boolean)
        .join("\n");
      try {
        const r = await callStructured<unknown>({
          client,
          model,
          systemPrompt: PEOPLE_SYSTEM_PROMPT,
          userMessage,
          toolName: "record_company_people",
          toolDescription: "Record the cited decision-makers found at this company.",
          toolInputSchema: peopleToolInputSchema,
          cacheSystem: true,
          webSearch: true,
          webSearchMaxUses: PEOPLE_SEARCH_BUDGET,
          webFetch: true,
          webFetchMaxUses: PEOPLE_FETCH_BUDGET,
          maxContentTokens: 6000,
          maxTokens: 6144,
          effort,
          webToolCalling,
          onProgress: opts.onProgress,
          signal: opts.signal,
        });
        spend(r.usage);
        searchesUsed += r.searchesUsed;
        fetchesUsed += r.fetchesUsed;
        const parsed = companyPeopleToolSchema.parse(stripNulls(r.output));
        const prospects = parsed.prospects
          .filter((p) => !excluded.names.has(fold(p.full_name)))
          .map((p) => ({
            ...p,
            // The company stage knows which company it was given; a model
            // that abbreviates or rebrands it would split the dedupe key.
            company: p.company?.trim() ? p.company : candidate.company,
            company_domain: p.company_domain ?? parsed.company_domain ?? candidate.company_domain,
            linkedin_url: plausibleProfileUrl(p.full_name, p.linkedin_url) ? p.linkedin_url : undefined,
            location: p.location ?? candidate.location,
          }))
          .slice(0, perCompany);
        opts.onCompany?.(candidate.company, prospects);
        return { candidate, prospects, notes: parsed.notes };
      } catch (err) {
        // One company failing (budget error, abort, bad output) must not
        // sink the round — same contract as the contact sweep.
        if (opts.signal?.aborted) throw err;
        return { candidate, prospects: [], notes: `search failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 200) };
      }
    },
  );

  // ---- stage 3: merge ----
  const prospects = mergeCompanyResults(
    perCompanyResults.map((r) => r.prospects),
    count,
  );

  let lookupSearches = 0;
  if (opts.resolveLinkedinUrls !== false) {
    const missing = prospects
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
        { client, onProgress: opts.onProgress, onUsage: opts.onUsage, signal: opts.signal },
      );
      lookupSearches = used;
      urls.forEach((url, i) => {
        const target = missing[i];
        if (url && target && plausibleProfileUrl(target.prospect.full_name, url)) {
          prospects[target.index]!.linkedin_url = url;
        }
      });
    }
  }

  const dry = perCompanyResults.filter((r) => r.prospects.length === 0).length;
  const high = prospects.filter((p) => p.confidence === "high").length;
  const sources = new Map<string, string>();
  for (const c of candidates) sources.set(c.source_url, c.company);
  for (const p of prospects) if (!sources.has(p.source_url)) sources.set(p.source_url, `${p.full_name} — ${p.company}`);
  const notes = [
    parsedPlan.research_notes,
    `${candidates.length} candidate companies searched in parallel; ${dry} returned nobody citable.`,
    ...perCompanyResults.filter((r) => r.notes?.startsWith("search failed")).map((r) => `${r.candidate.company}: ${r.notes}`),
  ]
    .filter(Boolean)
    .join(" ")
    .slice(0, 900);

  const result: ProspectSearch = {
    icp,
    prospects,
    meta: {
      confidence: prospects.length === 0 ? "low" : high * 2 >= prospects.length ? "high" : "medium",
      sources: [...sources.entries()].slice(0, 15).map(([url, label]) => ({ label: label.slice(0, 160), url })),
      research_notes: notes,
      searched_at: new Date().toISOString(),
      model,
      searches_used: searchesUsed + lookupSearches,
      fetches_used: fetchesUsed,
      schema_version: SCHEMA_VERSION,
    },
  };
  return prospectSearchSchema.parse(normalizeMetaField(result));
}
