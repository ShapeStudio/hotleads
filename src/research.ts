import Anthropic from "@anthropic-ai/sdk";
import { zodToJsonSchema } from "zod-to-json-schema";
import { callStructured, DEFAULT_MODEL, type EffortLevel, type OnProgress, type OnUsage } from "./anthropic.js";
import { fetchProxycurlProfile } from "./proxycurl.js";
import {
  normalizeMetaField,
  prospectResearchSchema,
  researchInputSchema,
  researchToolSchema,
  stripNulls,
  SCHEMA_VERSION,
  type ProspectResearch,
  type ResearchInput,
} from "./schema.js";

export type ResearchDepth = "standard" | "deep";

export interface ResearchOptions {
  /** Half-price Message Batches routing — minutes of latency, same output. */
  batchMode?: boolean;
  /** Defaults to process.env.ANTHROPIC_API_KEY. */
  anthropicApiKey?: string;
  /** Defaults to process.env.PROXYCURL_API_KEY. Optional — see README. */
  proxycurlApiKey?: string;
  /** Defaults to "claude-sonnet-5". */
  model?: string;
  /** standard = 13 web searches, deep = 17. */
  depth?: ResearchDepth;
  /** Override the search budget directly (wins over depth). */
  webSearchMaxUses?: number;
  /** output_config.effort — see callStructured. Unset = API default (high). */
  effort?: EffortLevel;
  /** "direct" skips the server-side filtering sandbox — see callStructured. */
  webToolCalling?: "filtered" | "direct";
  /** "excluded" stops consumed search results being echoed as output tokens. */
  responseInclusion?: "full" | "excluded";
  onProgress?: OnProgress;
  /** Token accounting, one call per model call. Telemetry only — see anthropic.ts. */
  onUsage?: OnUsage;
  signal?: AbortSignal;
}

const SEARCH_BUDGET: Record<ResearchDepth, number> = { standard: 13, deep: 17 };

/** Direct page fetches (web_fetch) — separate from the search budget. */
const FETCH_BUDGET = 5;

const SYSTEM_PROMPT = `You are a prospect-research analyst. Input: a person identified either by LinkedIn profile URL or by name + company (plus optional company URL and seller notes). Output: a deep, structured research dossier on the PERSON and their COMPANY, including how to actually reach them — recorded via the record_research tool.

The output is consumed programmatically (CRMs, outreach tooling, scripts) — completeness and honesty beat prose style. Fill every field you can verify; leave fields empty rather than guessing.

# Inputs you may receive
- linkedin_url (OPTIONAL) — when present, the strongest person anchor.
- name + company (the fallback anchor) — when there is no linkedin_url, THIS is the identity. Plenty of real decision-makers — owners of small firms especially — have no LinkedIn presence at all; that is normal and does not make them unresearchable. Work from the company's own site, business registers, directories, local press, and association listings instead. Do NOT treat a missing profile as a dead end, and do NOT go looking for a LinkedIn URL to fill in.
- company_url (optional but very valuable) — the prospect company's OWN website. When present, treat it as the CANONICAL company site: derive company.domain from it directly, anchor company searches on that exact domain, and base commercials on THAT site's pages. This kills the researching-a-same-named-different-company failure mode. Without a linkedin_url this site is your primary source — fetch it thoroughly.
- notes (optional seller context — factor into outreach angles)

# Identity discipline
Names repeat, especially common ones. Before attributing anything to this person, confirm the source ties the NAME to the COMPANY (or to the exact profile URL). If you cannot separate two same-named people, say so in research_notes, keep only what is jointly verified, and set meta.confidence to low. A confidently wrong dossier is the worst possible output.

# Role currency (mandatory)
The seller only cares about this person IF they still hold the role — outreach to someone who left the company is worse than no outreach. Actively check currency: is the person on the company's CURRENT team page (fetch it), and do the most RECENT sources (this year / last year) still tie them to the company? Watch the dates on everything you read.
- Still there → person.employment_status: "current".
- A newer source shows they LEFT → employment_status: "departed", the old role goes in past_experience (NEVER in current_role), employment_note says where they went and when (with the source), and current_role holds their NEW role only when verified.
- No source confirms either way (e.g. only a gated profile and stale pages) → employment_status: "unverified", and say so in research_notes.

# How to research

You have TWO server tools: web_search (search the public web) and web_fetch (retrieve a specific URL directly). web_fetch works even when a site is not indexed by any search engine — when company_url is given, FETCH it directly before relying on search results about the company; also fetch pages that search snippets reference when you need the full content.

Use them aggressively. Plan your searches (budget shown in the user message):

1. The person themselves. WITH a linkedin_url: \`site:linkedin.com/in "<name>"\` — headline, location, role, summary, education, past roles (search engines often surface gated-profile content in snippets). WITHOUT one: \`"<name>" "<company>"\` plus the company's own team/about/imprint page and the local business register — establish their exact role, tenure, and ownership stake from those instead.
2. \`"<name>" "<company>"\` — articles, podcasts, talks, conference bios, association memberships, local press.
3. \`"<company>" about\` AND — when company_url is given — web_fetch that URL directly (mandatory; the site may not be indexed at all): official site, products, positioning, industry, HQ, founding year, employee count.
4. \`"<name>" twitter OR github OR substack\` — public social links + what they think about lately.
5. \`"<company>" competitors\` OR \`"<company>" vs\` — 2-5 DIRECT competitors (same market, same buyer, wherever based). For each: where they stand, and how the researched company positions (or could position) against them.
6. \`similarweb "<domain>"\` OR \`"<company>" monthly visitors\` — traffic estimate. Also skim their product pages for price points → aov estimate + pricing model.
7. \`"<company>" funding OR crunchbase OR "raised"\` — funding block: total raised, last round, date, notable investors.
8. \`"<company>" news\` (current year) — 2-5 recent news items, each with a one-line why_it_matters for a seller.
9. \`"<company>" careers OR hiring\` — hiring signals: actively hiring? which roles?
10. CONTACT ROUTES — web_fetch the company's contact / "kontakt" / about / imprint / impressum page (these carry published phone numbers, emails and addresses, and are frequently not in search snippets). Fill the contact block.
11. \`"<name>" email OR contact OR "@<domain>"\` — a published direct address or direct line for THIS person: register entries, talk/speaker bios, press releases, association directories, their own site.
12-13. Open follow-ups on the strongest signals the prior searches surfaced (a named project, a conference talk, an acquisition rumor).

With a deep budget, spend the extra searches on: a second news pass, executive-team context, verifying the competitor list from a second angle, and a second contact-route attempt.

# Field rules

- person.about: 2-4 sentences in your own voice — what this person does and is known for.
- person.photo_url: only a public URL you actually saw; never construct one.
- company.domain: cleanest root domain, no protocol/path. From company_url when given.
- company.logo_url: https://logo.clearbit.com/{domain} is acceptable once you know the domain.
- commercials: estimate strings ALWAYS carry their basis ("~80,000 monthly visits (SimilarWeb estimate)"). Numeric twins (monthly_traffic, aov) are plain numbers — fill both forms or neither. Never invent precision; empty + a research_notes line beats a made-up number.
- competitors[].note: grounded in something you read. competitors[].vs_positioning: how the researched company wins or differs — category-level reasoning is fine, invented facts are not. Fill hq_location when known.
- contact: PUBLISHED business contact details only, each with the source_url you read it from. Record what the page actually shows — a company switchboard or info@ address is a useful, honest answer; label it as such ("company switchboard", "general info@ inbox", "direct line"). Set reach on every item: "direct" ONLY when the page ties the detail to THIS person by name, "company" for shared routes. NEVER construct an address from a name pattern (first.last@company.com, initials@…) or from another employee's address: guessed addresses are usually wrong, they bounce, and they damage the sender's domain reputation. Prefer a person's direct details when published; otherwise give the company route and say so in contact.note. If nothing is published anywhere, leave the block empty and say that in the note — that is a legitimate result.
- outreach: written FOR a seller approaching this person. likely_pain_points and hooks tie to the role + company stage. icebreakers are ready-to-send opening lines referencing something real from the research. talking_points cite researched specifics.
- meta.confidence: high / medium / low by how much you actually verified.
- meta.profile_accessible: TRUE whenever you verified this person's role and company from any source. Set FALSE only when the person could not be verified at all — a member-gated LinkedIn profile with nothing else, or a name you could never tie to the company. Having no LinkedIn profile is NOT by itself a reason to set it false.
- meta.sources: every page that informed the dossier (up to 12). Real URLs you retrieved via web_search only.
- meta.research_notes: 1-3 sentences on what was hard to find or where you're estimating.

# Rules
- Write all output field values in English, regardless of the source pages' language. Keep proper nouns as-is.
- Do not fabricate verifiable specifics (revenue, headcount, named clients, deal sizes). Unverified → leave empty, note it.
- Distinguish what you read from what you inferred.
- sources URLs must be pages you actually retrieved.
- Output ONLY via the record_research tool — no prose response.`;

const toolInputSchema = zodToJsonSchema(researchToolSchema, {
  $refStrategy: "none",
  target: "openApi3",
}) as Record<string, unknown>;

/**
 * Pretty-name fallback from the LinkedIn URL slug:
 *   linkedin.com/in/ziga-kerec-72b3a8 → "Ziga Kerec"
 * Research overrides this with the verified name.
 */
export function nameFromLinkedinUrl(url: string): string {
  try {
    const u = new URL(url);
    const slug = u.pathname.split("/in/")[1]?.split("/")[0] ?? "";
    const parts = slug.split("-").filter((p) => !/^\d+$|^[a-f0-9]{6,}$/i.test(p));
    const pretty = parts
      .map((p) => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase())
      .join(" ")
      .slice(0, 60);
    return pretty || "Unknown";
  } catch {
    return "Unknown";
  }
}

/**
 * Research one prospect. Resolves to the full structured dossier;
 * throws on invalid input, missing API key, or model/API failure.
 */
export async function research(
  input: ResearchInput,
  opts: ResearchOptions = {},
): Promise<ProspectResearch> {
  const parsedInput = researchInputSchema.parse(input);

  const apiKey = opts.anthropicApiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      "Missing Anthropic API key. Set ANTHROPIC_API_KEY (get one at https://console.anthropic.com) or pass opts.anthropicApiKey.",
    );
  }
  const proxycurlKey = opts.proxycurlApiKey ?? process.env.PROXYCURL_API_KEY;
  const model = opts.model ?? DEFAULT_MODEL;
  const depth: ResearchDepth = opts.depth ?? "standard";

  const client = new Anthropic({ apiKey });

  // Optional verified ground truth for gated profiles. Only meaningful when
  // we actually have a profile URL.
  const proxycurl = parsedInput.linkedin_url
    ? await fetchProxycurlProfile(parsedInput.linkedin_url, proxycurlKey)
    : null;

  // With verified profile data already in context, the person-identity
  // searches (steps 1 and 4) mostly re-derive what Proxycurl handed us —
  // trim the budget rather than re-buy it. The role-currency check keeps
  // its searches: Proxycurl data can be stale.
  const searchBudget =
    opts.webSearchMaxUses ?? (proxycurl ? SEARCH_BUDGET[depth] - 3 : SEARCH_BUDGET[depth]);

  // With a URL the slug is a usable fallback name; without one the schema
  // guarantees an explicit name.
  const nameHint =
    parsedInput.name ??
    (parsedInput.linkedin_url ? nameFromLinkedinUrl(parsedInput.linkedin_url) : "Unknown");

  const userMessage = [
    `# Prospect`,
    parsedInput.linkedin_url
      ? `LinkedIn: ${parsedInput.linkedin_url}`
      : `LinkedIn: none known — identify this person by name + company, from the company site and public records. Do not go hunting for a profile URL.`,
    `Name hint (verify): ${nameHint}`,
    parsedInput.company ? `Company hint (verify): ${parsedInput.company}` : null,
    parsedInput.company_url
      ? `Company website (canonical — anchor company research here): ${parsedInput.company_url}`
      : null,
    parsedInput.notes ? `\n# Seller notes\n${parsedInput.notes}` : null,
    proxycurl
      ? [
          `\n# Verified LinkedIn data (Proxycurl)`,
          `Treat as ground truth for person identity/history fields. Set meta.profile_accessible: true.`,
          `Still web_search for company, competitors, commercials, news, and anything that looks stale.`,
          "```json",
          JSON.stringify(proxycurl, null, 2),
          "```",
        ].join("\n")
      : null,
    ``,
    `Search budget: up to ${searchBudget} web searches. Research deeply and call record_research with everything you can verify.`,
  ]
    .filter(Boolean)
    .join("\n");

  const { output, searchesUsed, fetchesUsed, usage } = await callStructured<unknown>({
    client,
    model,
    systemPrompt: SYSTEM_PROMPT,
    userMessage,
    toolName: "record_research",
    toolDescription:
      "Record the structured prospect-research dossier: person, company, competitors, commercials, outreach angles, and meta/provenance.",
    toolInputSchema,
    cacheSystem: true,
    webSearch: true,
    webSearchMaxUses: searchBudget,
    webFetch: true,
    webFetchMaxUses: FETCH_BUDGET,
    // Same reasoning as search.ts: a fetched page is paid again on every
    // subsequent turn, so cap it at what a profile, about or news page needs.
    maxContentTokens: 8000,
    maxTokens: 8192,
    effort: opts.effort,
    webToolCalling: opts.webToolCalling,
    responseInclusion: opts.responseInclusion,
    onProgress: opts.onProgress,
    signal: opts.signal,
    batch: opts.batchMode,
    // Nobody is watching a batch dossier — wait out a slow queue instead of
    // canceling at 10 min and re-paying full price on the live API.
    batchWaitMs: opts.batchMode ? 35 * 60_000 : undefined,
  });

  // Report spend before parsing: the tokens are already bought whether or
  // not the output validates.
  opts.onUsage?.(usage);

  // Models emit explicit nulls for unfillable optional fields — strip them
  // before validation (see stripNulls docs) — and occasionally emit meta as
  // a prose string (see normalizeMetaField docs).
  const parsed = researchToolSchema.parse(normalizeMetaField(stripNulls(output)));

  // Code-filled meta — never trusted to the model.
  const result: ProspectResearch = {
    ...parsed,
    meta: {
      ...(parsed.meta ?? {}),
      researched_at: new Date().toISOString(),
      model,
      searches_used: searchesUsed,
      fetches_used: fetchesUsed,
      schema_version: SCHEMA_VERSION,
    },
  };

  // Echo the input URL into the dossier for downstream joins.
  if (parsedInput.linkedin_url) result.person.linkedin_url ??= parsedInput.linkedin_url;

  return prospectResearchSchema.parse(result);
}
