// What does the model emit between its last tool call and the output tool?
// Streams one search request with the production parameters and logs every
// content block: type, when it started, how many chars it carried.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import { zodToJsonSchema } from "zod-to-json-schema";
import { prospectSearchToolSchema } from "../src/schema.js";

const OUT = new URL("./out/", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const searchSrc = readFileSync("../src/search.ts", "utf8");
const BASE_PROMPT = searchSrc.match(/const SYSTEM_PROMPT = `([\s\S]*?)`;\n\nconst toolInputSchema/)![1]!.replace(/\\`/g, "`");
const apiKey = process.env.ANTHROPIC_API_KEY; if (!apiKey) throw new Error("set ANTHROPIC_API_KEY");
const { search_callers, fetch_callers, search_tool, fetch_tool, response_inclusion, ...extra } = JSON.parse(process.argv[2] ?? "{}") as Record<string, any>; // e.g. {"output_config":{"effort":"low"}} or {"search_callers":["direct"]}
const label = process.argv[3] ?? "probe";

const TARGET = "Founders, heads of sales and heads of growth at B2B SaaS and agency companies with 10–200 employees in Europe who run outbound prospecting and want cited lead lists fast.";
const userMessage = `# Seller\nCompany website (canonical — the ICP starts here): https://hotleads.si\n\n# Target customer (provided by the seller — adopt as the ICP)\n${TARGET}\n\nFind up to 10 prospects across at least 5 distinct companies.\nBudgets: up to 14 web searches and up to 5 direct page fetches. Fetch the company website first, research deeply, and call record_prospect_search with the ICP and every prospect you can cite.`;

const client = new Anthropic({ apiKey });
const t0 = Date.now();
const blocks: { i: number; type: string; name?: string; start: number; end?: number; chars: number }[] = [];
const stream = client.messages.stream(
  {
    model: "claude-sonnet-5",
    max_tokens: 8192,
    system: [{ type: "text", text: BASE_PROMPT, cache_control: { type: "ephemeral" } }],
    tools: [
      { name: "record_prospect_search", description: "Record the structured prospect search.", input_schema: zodToJsonSchema(prospectSearchToolSchema, { $refStrategy: "none", target: "openApi3" }) as never },
      { type: search_tool ?? "web_search_20260209", name: "web_search", max_uses: 14, ...(search_callers ? { allowed_callers: search_callers } : {}), ...(response_inclusion ? { response_inclusion } : {}) } as never,
      { type: fetch_tool ?? "web_fetch_20260209", name: "web_fetch", max_uses: 5, max_content_tokens: 8000, ...(fetch_callers ? { allowed_callers: fetch_callers } : {}), ...(response_inclusion ? { response_inclusion } : {}) } as never,
    ],
    tool_choice: { type: "auto" },
    messages: [{ role: "user", content: userMessage }],
    ...extra,
  } as never,
  { headers: { "anthropic-beta": "web-fetch-2025-09-10" } },
);
stream.on("streamEvent", (ev: any) => {
  const t = Date.now() - t0;
  if (ev.type === "content_block_start") {
    blocks.push({ i: ev.index, type: ev.content_block.type, name: ev.content_block.name, start: t, chars: 0 });
    console.error(`${(t / 1000).toFixed(1)}s START ${ev.content_block.type}${ev.content_block.name ? ":" + ev.content_block.name : ""}`);
  } else if (ev.type === "content_block_delta") {
    const b = blocks.find((x) => x.i === ev.index); if (!b) return;
    const d = ev.delta;
    b.chars += (d.text ?? d.thinking ?? d.partial_json ?? "").length;
  } else if (ev.type === "content_block_stop") {
    const b = blocks.find((x) => x.i === ev.index); if (b) { b.end = t; console.error(`${(t / 1000).toFixed(1)}s STOP  ${b.type}${b.name ? ":" + b.name : ""} chars=${b.chars} dur=${((t - b.start) / 1000).toFixed(1)}s`); }
  }
});
const msg = await stream.finalMessage();
const total = Date.now() - t0;
const byType: Record<string, { n: number; chars: number; secs: number }> = {};
for (const b of blocks) { const k = b.type + (b.name ? ":" + b.name : ""); byType[k] ??= { n: 0, chars: 0, secs: 0 }; byType[k].n++; byType[k].chars += b.chars; byType[k].secs += ((b.end ?? total) - b.start) / 1000; }
// Server tool results arrive as whole blocks (no deltas) — their error codes
// live in the final content, so keep it, minus page bodies.
const content = (msg.content as any[]).map((b) => {
  if (b.type === "web_search_tool_result" || b.type === "web_fetch_tool_result") {
    const c = b.content;
    return { type: b.type, content: Array.isArray(c) ? c.map((r: any) => ({ type: r.type, url: r.url, title: r.title })) : (c?.type === "web_fetch_result" ? { type: c.type, url: c.url, retrieved_at: c.retrieved_at } : c) };
  }
  if (b.type === "text" || b.type === "thinking") return { type: b.type, chars: (b.text ?? b.thinking ?? "").length, head: (b.text ?? b.thinking ?? "").slice(0, 300) };
  if (b.type === "tool_use") return { type: b.type, name: b.name, chars: JSON.stringify(b.input).length };
  return b;
});
const errors = content.flatMap((b: any) => Array.isArray(b.content) ? b.content.filter((r: any) => String(r.type).includes("error")) : (b.content && String(b.content.type ?? "").includes("error") ? [b.content] : []));
const report = { label, extra: { ...extra, search_callers, fetch_callers, search_tool, fetch_tool, response_inclusion }, total_s: +(total / 1000).toFixed(1), stop_reason: msg.stop_reason, usage: msg.usage, byType, errors, blocks, content };
writeFileSync(`${OUT}/probe-${label}-${Date.now()}.json`, JSON.stringify(report, null, 2));
console.error("REPORT", JSON.stringify({ label, total_s: report.total_s, stop_reason: msg.stop_reason, usage: msg.usage, byType, errors }));
