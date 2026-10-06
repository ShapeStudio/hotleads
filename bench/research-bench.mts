// Timing harness for one dossier (research) under effort/calling variants.
// Usage: tsx research-bench.mts <variant> [...]
import { readFileSync, writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import { research } from "../src/research.js";
import type { ProgressEvent, CallUsage } from "../src/anthropic.js";

const OUT = new URL("./out/", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const apiKey = process.env.ANTHROPIC_API_KEY; if (!apiKey) throw new Error("set ANTHROPIC_API_KEY");
// A public founder profile with plenty of citable material; same input every run.
const INPUT = { linkedin_url: "https://www.linkedin.com/in/joranhofman/", company_url: "https://www.getreditus.com", notes: "Seller: HotLeads (hotleads.si), AI lead research + outreach for B2B founders." };

type V = { effort?: "low" | "medium" | "high"; calling?: "filtered" | "direct" };
const VARIANTS: Record<string, V> = {
  "r-default": {},
  "r-direct-high": { calling: "direct" },
  "r-direct-medium": { calling: "direct", effort: "medium" },
  "r-direct-low": { calling: "direct", effort: "low" },
};

for (const name of process.argv.slice(2)) {
  const v = VARIANTS[name]; if (!v) throw new Error(`unknown ${name}`);
  const t0 = Date.now(); const timeline: { t: number; ev: string }[] = []; const usages: CallUsage[] = [];
  let error: string | null = null; let out: any = null;
  try {
    out = await research(INPUT, {
      anthropicApiKey: apiKey, effort: v.effort, webToolCalling: v.calling,
      onProgress: (e: ProgressEvent) => { const t = Date.now() - t0; const ev = e.type === "search" ? `search#${e.index} ${e.query}` : e.type === "fetch" ? `fetch#${e.index} ${e.url}` : e.type; timeline.push({ t, ev }); console.error(`[${name}] ${(t / 1000).toFixed(1)}s ${ev}`); },
      onUsage: (u) => usages.push(u),
    });
  } catch (e) { error = e instanceof Error ? e.message : String(e); }
  const total = Date.now() - t0;
  const outputStarted = timeline.find((x) => x.ev === "output_started")?.t ?? null;
  const summary = {
    variant: name, effort: v.effort ?? "high", calling: v.calling ?? "filtered", error,
    total_s: +(total / 1000).toFixed(1), output_started_s: outputStarted != null ? +(outputStarted / 1000).toFixed(1) : null,
    searches: timeline.filter((x) => x.ev.startsWith("search#")).length, fetches: timeline.filter((x) => x.ev.startsWith("fetch#")).length,
    out_tok: usages.reduce((s, u) => s + u.output_tokens, 0),
    sources: out?.meta?.sources?.length ?? 0, competitors: out?.competitors?.length ?? 0,
    outreach_angles: out?.outreach?.angles?.length ?? (Array.isArray(out?.outreach) ? out.outreach.length : 0),
    confidence: out?.meta?.confidence ?? null, has_company_summary: Boolean(out?.company?.summary), contact_emails: out?.contact?.emails?.length ?? 0,
    json_chars: out ? JSON.stringify(out).length : 0,
  };
  writeFileSync(`${OUT}/${name}-${Date.now()}.json`, JSON.stringify({ summary, timeline, usages, out }, null, 2));
  appendFileSync(`${OUT}/research-summary.jsonl`, JSON.stringify(summary) + "\n");
  console.error(`[${name}] DONE`, JSON.stringify(summary));
}
