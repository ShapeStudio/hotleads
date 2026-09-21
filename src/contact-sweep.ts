// Cheap contact enrichment: published contact details for ONE company and
// the named people at it — without the full research dossier. The whole
// point is cost: it runs on a small model, leans on web_fetch (which has no
// per-use fee — only web_search does), and asks for nothing but the contact
// block. Typical spend is a few cents per company vs ~$0.35-0.50 for a deep
// dossier, which is what makes "contact details for every lead" viable.
//
// Same honesty contract as everywhere else in this engine: only details
// actually published somewhere, each with the page it was read from, never
// a pattern-guessed address.

import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { callStructured, type OnProgress, type OnUsage } from "./anthropic.js";
import { contactSchema, type Contact } from "./schema.js";

/** Small model on purpose — contact-page extraction needs no judgment. */
export const SWEEP_MODEL = "claude-haiku-4-5";

const SYSTEM_PROMPT = `You are a contact-details researcher. Input: one company (name, usually a domain) and the names of people who work there. Output: the company's PUBLISHED contact details, plus any published DIRECT details for the named people — recorded via the record_contacts tool.

Method — fetches first, searches only as fallback:
1. If a domain is given, web_fetch the likely contact pages directly: /contact, /kontakt, /impressum, /imprint, /about, /o-nas (adapt to the site's language). These pages are frequently not in search snippets, so fetch them — do NOT search for what a fetch can read.
2. Only if fetching fails or yields nothing, use web_search (you have very few searches — spend them on business-register or directory entries for the company).

Rules:
- Record ONLY details actually published on a page you read, each with its source_url and a short label saying what it reaches ("company switchboard", "info@ inbox", "direct line — <person>", "mobile — <person>").
- For the named people: include a detail ONLY when the page ties it to that person by name. Label it with the person's name.
- NEVER construct an email from a name pattern (first.last@domain, initials@…) or from a colleague's address. A guessed address is worse than none.
- If nothing is published, return an empty block and say so in contact.note — that is a legitimate result.
- contact.note: one or two sentences on the best route in (e.g. "switchboard + contact form only; no direct details published").`;

const sweepInputSchema = z.object({
  /** Company name as saved on the leads. */
  company: z.string().min(1).max(160),
  /** Bare domain when known (e.g. "acme.si") — enables direct fetches. */
  company_domain: z.string().max(160).optional(),
  /** People at this company to look for direct details for. */
  people: z
    .array(z.object({ full_name: z.string().max(120), title: z.string().max(160).optional() }))
    .max(15)
    .default([]),
});

export type ContactSweepInput = z.input<typeof sweepInputSchema>;

export interface ContactSweepOptions {
  anthropicApiKey?: string;
  /** Override the sweep model (default claude-haiku-4-5). */
  model?: string;
  onProgress?: OnProgress;
  /** Token accounting, one call per model call. Telemetry only — see anthropic.ts. */
  onUsage?: OnUsage;
  signal?: AbortSignal;
}

export interface ContactSweepResult {
  contact: Contact;
  searchesUsed: number;
  fetchesUsed: number;
}

const toolInputSchema = zodToJsonSchema(z.object({ contact: contactSchema }), {
  $refStrategy: "none",
  target: "openApi3",
}) as Record<string, unknown>;

/**
 * Find published contact details for one company + its named people.
 * Resolves to the contact block (possibly empty — honesty over invention).
 */
export async function sweepCompanyContacts(
  input: ContactSweepInput,
  opts: ContactSweepOptions = {},
): Promise<ContactSweepResult> {
  const parsed = sweepInputSchema.parse(input);
  const apiKey = opts.anthropicApiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      "Missing Anthropic API key. Set ANTHROPIC_API_KEY (get one at https://console.anthropic.com) or pass opts.anthropicApiKey.",
    );
  }

  const userMessage = [
    `# Company`,
    `Name: ${parsed.company}`,
    parsed.company_domain ? `Domain: ${parsed.company_domain}` : null,
    parsed.people.length > 0
      ? `\n# People at this company (direct details wanted when published)\n${parsed.people
          .map((p) => `- ${p.full_name}${p.title ? ` (${p.title})` : ""}`)
          .join("\n")}`
      : null,
    `\nFetch the contact pages, record every published detail with its source, and call record_contacts.`,
  ]
    .filter(Boolean)
    .join("\n");

  const { output, searchesUsed, fetchesUsed, usage } = await callStructured<{ contact?: unknown }>({
    client: new Anthropic({ apiKey }),
    model: opts.model ?? SWEEP_MODEL,
    systemPrompt: SYSTEM_PROMPT,
    userMessage,
    toolName: "record_contacts",
    toolDescription:
      "Record the company's published contact details (and any published direct details for the named people), each with a label and the source page it was read from.",
    toolInputSchema,
    cacheSystem: true,
    webSearch: true,
    webSearchMaxUses: 2,
    webFetch: true,
    webFetchMaxUses: 5,
    maxTokens: 2000,
    onProgress: opts.onProgress,
    signal: opts.signal,
  });

  opts.onUsage?.(usage);

  const contact = contactSchema.parse(
    (output as { contact?: unknown }).contact ?? {},
  );
  return { contact, searchesUsed, fetchesUsed };
}
