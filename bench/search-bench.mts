// Timing harness for the engine's prospect search. Runs the raw search call
// (the 2–3.5 min step) under named variants against ONE fixed seller input
// and records wall-clock, per-event timeline, tokens and result quality.
// Usage: tsx search-bench.ts <variant> [<variant>...]
import { readFileSync, writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import { zodToJsonSchema } from "zod-to-json-schema";
import { callStructured, type ProgressEvent, type CallUsage } from "../src/anthropic.js";
import {
  prospectSearchToolSchema,
  normalizeMetaField,
  stripNulls,
} from "../src/schema.js";
import { resolveLinkedinUrls } from "../src/linkedin-lookup.js";
import { searchProspectsStaged } from "../src/search-staged.js";

const OUT = new URL("./out/", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

// Pull the production system prompt out of search.ts so variants are deltas
// on exactly what ships.
const searchSrc = readFileSync(new URL("../src/search.ts", import.meta.url), "utf8");
const m = searchSrc.match(/const SYSTEM_PROMPT = `([\s\S]*?)`;\n\nconst toolInputSchema/);
if (!m) throw new Error("could not extract SYSTEM_PROMPT");
const BASE_PROMPT = m[1]!.replace(/\\`/g, "`");

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) throw new Error("no ANTHROPIC_API_KEY");

const COMPANY_URL = "https://hotleads.si";
const TARGET =
  "Founders, heads of sales and heads of growth at B2B SaaS and agency companies with 10–200 employees in Europe who run outbound prospecting and want cited lead lists fast.";
const COUNT = 10;
const FETCH_BUDGET = 5;

const PARALLEL_HINT = `

# Speed
Searches that do not depend on each other's results — people searches across several candidate companies, the verification passes for different people, hiring and funding checks for different companies — must be issued TOGETHER in one turn (several web_search calls in the same response), not one per turn. Only serialise a search when it needs the previous result. The same applies to web_fetch of several team pages.`;

const NO_FETCH_WHEN_TARGET = BASE_PROMPT.replace(
  "1. MANDATORY FIRST STEP: web_fetch the company_url directly. The fetched page is the ground truth for what they sell — never skip this, and never substitute a search for it. If the homepage is thin, fetch 1-2 key subpages (pricing, product, about). Complement with `site:<domain>` search. This is the ICP foundation.",
  "1. ICP grounding: when a seller profile or target is given it IS the ground truth — do NOT fetch or search the seller's own site; spend every search on finding people. Only when neither is given, web_fetch the company_url first (it is the ICP foundation; if the homepage is thin, fetch 1-2 key subpages).",
);
if (NO_FETCH_WHEN_TARGET === BASE_PROMPT) throw new Error("no-fetch replace failed");

const TERSE_HINT = `

# Output discipline
Do NOT write prose, plans, running notes or summaries between tool calls — no text blocks at all. Issue tool calls, read results, and when the budget is spent or the list is complete call record_prospect_search immediately. Keep why_relevant to one short sentence and research_notes to at most two. Every token of narration delays the seller without adding a single lead.`;

type Variant = { prompt: string; budget: number; maxContent: number; model?: string; lookup?: boolean; effort?: "low" | "medium" | "high"; calling?: "filtered" | "direct"; staged?: boolean };
const VARIANTS: Record<string, Variant> = {
  // What ships today (after this morning's 8k cap).
  base:         { prompt: BASE_PROMPT, budget: 14, maxContent: 8000, lookup: true },
  // Same budgets, prompt asks for parallel tool calls within a turn.
  parallel:     { prompt: BASE_PROMPT + PARALLEL_HINT, budget: 14, maxContent: 8000 },
  // Parallel + skip the seller-site fetch when a target is given.
  nofetch:      { prompt: NO_FETCH_WHEN_TARGET + PARALLEL_HINT, budget: 14, maxContent: 8000 },
  // Leaner budget on top of nofetch+parallel.
  lean:         { prompt: NO_FETCH_WHEN_TARGET + PARALLEL_HINT, budget: 10, maxContent: 6000 },
  // nofetch + parallel + no narration between tool calls.
  terse:        { prompt: NO_FETCH_WHEN_TARGET + PARALLEL_HINT + TERSE_HINT, budget: 14, maxContent: 8000 },
  // Candidate production configs: no seller-site fetch when a target is
  // given, direct web tools (no filtering sandbox), effort swept.
  "direct-low":    { prompt: NO_FETCH_WHEN_TARGET + PARALLEL_HINT, budget: 14, maxContent: 8000, calling: "direct", effort: "low", lookup: true },
  "direct-medium": { prompt: NO_FETCH_WHEN_TARGET + PARALLEL_HINT, budget: 14, maxContent: 8000, calling: "direct", effort: "medium", lookup: true },
  "direct-high":   { prompt: NO_FETCH_WHEN_TARGET + PARALLEL_HINT, budget: 14, maxContent: 8000, calling: "direct", lookup: true },
  // The staged orchestrator (plan → per-company fan-out → merge), engine defaults.
  staged:          { prompt: "", budget: 0, maxContent: 0, staged: true },
  // Old 15k fetched-page cap, for the before/after of this morning's change.
  cap15k:       { prompt: BASE_PROMPT, budget: 14, maxContent: 15000 },
};

const toolInputSchema = zodToJsonSchema(prospectSearchToolSchema, { $refStrategy: "none", target: "openApi3" }) as Record<string, unknown>;

async function runVariant(name: string) {
  const v = VARIANTS[name];
  if (!v) throw new Error(`unknown variant ${name}`);
  const client = new Anthropic({ apiKey });
  const t0 = Date.now();
  const timeline: { t: number; ev: string }[] = [];
  const usages: CallUsage[] = [];
  let turns = 0; // approximated: each search/fetch event is one server-tool round
  const onProgress = (e: ProgressEvent) => {
    const t = Date.now() - t0;
    if (e.type === "search") { turns++; timeline.push({ t, ev: `search#${e.index} ${e.query}` }); }
    else if (e.type === "fetch") { turns++; timeline.push({ t, ev: `fetch#${e.index} ${e.url}` }); }
    else timeline.push({ t, ev: e.type });
    console.error(`[${name}] ${(t / 1000).toFixed(1)}s ${timeline.at(-1)!.ev}`);
  };
  const minCompanies = Math.min(Math.ceil(COUNT / 2), 5);
  const userMessage = [
    `# Seller`,
    `Company website (canonical — the ICP starts here): ${COMPANY_URL}`,
    `\n# Target customer (provided by the seller — adopt as the ICP)\n${TARGET}`,
    `\nFind up to ${COUNT} prospects across at least ${minCompanies} distinct companies.`,
    `Budgets: up to ${v.budget} web searches and up to ${FETCH_BUDGET} direct page fetches. ${v.prompt === BASE_PROMPT || v.prompt === BASE_PROMPT + PARALLEL_HINT ? "Fetch the company website first, research deeply," : "Research deeply,"} and call record_prospect_search with the ICP and every prospect you can cite.`,
  ].join("\n");

  let error: string | null = null;
  let parsed: ReturnType<typeof prospectSearchToolSchema.parse> | null = null;
  let searchesUsed = 0, fetchesUsed = 0;
  let firstCompanyAt: number | null = null;
  if (v.staged) {
    try {
      const r = await searchProspectsStaged(
        { company_url: COMPANY_URL, target: TARGET, count: COUNT },
        {
          anthropicApiKey: apiKey,
          onProgress,
          onUsage: (u) => usages.push(u),
          onCompany: (company, ps) => { const t = Date.now() - t0; if (firstCompanyAt == null && ps.length) firstCompanyAt = t; timeline.push({ t, ev: `company ${company}: ${ps.length}` }); console.error(`[${name}] ${(t / 1000).toFixed(1)}s company ${company}: ${ps.length}`); },
        },
      );
      parsed = r as any;
      searchesUsed = r.meta.searches_used ?? 0; fetchesUsed = r.meta.fetches_used ?? 0;
      timeline.push({ t: Date.now() - t0, ev: "output_started" });
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  } else try {
    const r = await callStructured<unknown>({
      client,
      model: v.model,
      systemPrompt: v.prompt,
      userMessage,
      toolName: "record_prospect_search",
      toolDescription: "Record the structured prospect search: the ICP committed to, the list of cited prospects, and meta/provenance.",
      toolInputSchema,
      cacheSystem: true,
      webSearch: true,
      webSearchMaxUses: v.budget,
      webFetch: true,
      webFetchMaxUses: FETCH_BUDGET,
      maxContentTokens: v.maxContent,
      maxTokens: 8192,
      effort: v.effort,
      webToolCalling: v.calling,
      onProgress,
    });
    usages.push(r.usage);
    searchesUsed = r.searchesUsed; fetchesUsed = r.fetchesUsed;
    parsed = prospectSearchToolSchema.parse(normalizeMetaField(stripNulls(r.output)));
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  const searchMs = Date.now() - t0;

  let lookupMs = 0, lookupFilled = 0, lookupMissing = 0;
  if (v.lookup && parsed) {
    const missing = parsed.prospects.filter((p) => !p.linkedin_url).slice(0, 10);
    lookupMissing = missing.length;
    if (missing.length) {
      const l0 = Date.now();
      const { urls } = await resolveLinkedinUrls(
        missing.map((p) => ({ full_name: p.full_name, company: p.company, title: p.title })),
        { client, onUsage: (u) => usages.push(u) },
      );
      lookupMs = Date.now() - l0;
      lookupFilled = urls.filter(Boolean).length;
    }
  }

  const outputStarted = timeline.find((x) => x.ev === "output_started")?.t ?? null;
  const prospects = parsed?.prospects ?? [];
  const summary = {
    variant: name, effort: v.staged ? 'medium' : (v.effort ?? 'high'), calling: v.staged ? 'direct' : (v.calling ?? 'filtered'), staged: Boolean(v.staged), first_company_s: firstCompanyAt != null ? +(firstCompanyAt / 1000).toFixed(1) : null, error,
    search_s: +(searchMs / 1000).toFixed(1),
    output_started_s: outputStarted != null ? +(outputStarted / 1000).toFixed(1) : null,
    write_s: outputStarted != null ? +((searchMs - outputStarted) / 1000).toFixed(1) : null,
    lookup_s: +(lookupMs / 1000).toFixed(1), lookup_filled: lookupFilled, lookup_missing: lookupMissing,
    searches: searchesUsed, fetches: fetchesUsed, tool_rounds: turns,
    prospects: prospects.length,
    companies: new Set(prospects.map((p) => p.company)).size,
    with_url: prospects.filter((p) => p.linkedin_url).length,
    high: prospects.filter((p) => p.confidence === "high").length,
    medium: prospects.filter((p) => p.confidence === "medium").length,
    low: prospects.filter((p) => p.confidence === "low").length,
    in_tok: usages.reduce((s, u) => s + u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens, 0),
    out_tok: usages.reduce((s, u) => s + u.output_tokens, 0),
  };
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  writeFileSync(`${OUT}/${name}-${stamp}.json`, JSON.stringify({ summary, timeline, usages, prospects, icp: parsed?.icp, notes: parsed?.meta?.research_notes }, null, 2));
  appendFileSync(`${OUT}/summary.jsonl`, JSON.stringify(summary) + "\n");
  console.error(`[${name}] DONE`, JSON.stringify(summary));
}

const names = process.argv.slice(2);
if (names.length === 0) { console.error("variants:", Object.keys(VARIANTS).join(" ")); process.exit(1); }
for (const n of names) await runVariant(n);
