// Reverse email lookup: who owns this address? Searches the exact address,
// reads the domain's site (team/about/imprint pages), and returns the person
// ONLY when a citable page ties them to the address or its local part.
// Same honesty contract as the rest of the engine: found or empty — never a
// guess. A generic-provider address (gmail…) with no exact-match hits is a
// legitimate "not found".

import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { callStructured, type OnProgress } from "./anthropic.js";
import { contactSchema, type Contact } from "./schema.js";

const SYSTEM_PROMPT = `You are an identity researcher. Input: one email address. Output: who it belongs to — recorded via the record_email_identity tool. Only report what a page you actually read supports.

Method:
1. web_search the EXACT address in quotes ("name@company.com") — signatures, imprints, directories, conference bios, press releases.
2. Parse the domain. If it's a company domain, web_fetch the site's likely people pages (/team, /about, /contact, /impressum, adapt to language) and match the LOCAL PART against listed people (jan.novak@ → Jan Novak listed on the team page is a match; info@ / office@ match the COMPANY, not a person).
3. If you identify the person, one targeted search for their LinkedIn profile URL ("<name>" "<company>" linkedin) — record it only when the profile plainly matches.

Rules:
- found=true ONLY when a citable source ties the address (or its local part on that domain) to a named person. Record every claim's source URL in sources.
- A role address (info@, office@, sales@) identifies the COMPANY: set found=false for the person but fill company when the domain's site confirms it, and say so in note.
- Generic providers (gmail, outlook, yahoo…): only exact-address hits count; no hits → found=false.
- contacts: OTHER published details for the person/company you saw along the way (labeled, sourced) — never pattern-guessed.
- confidence: "high" (page shows the address or local-part match on the exact domain), "medium" (strong indirect match), "low" (weak signals — prefer found=false over low-confidence guesses).`;

const identitySchema = z.object({
  found: z.boolean(),
  person: z
    .object({
      full_name: z.string().max(120),
      title: z.string().max(160).optional(),
      location: z.string().max(120).optional(),
    })
    .optional(),
  company: z
    .object({
      name: z.string().max(160).optional(),
      domain: z.string().max(160).optional(),
    })
    .optional(),
  linkedin_url: z.string().max(300).optional(),
  contacts: contactSchema.optional(),
  confidence: z.enum(["high", "medium", "low"]).optional(),
  sources: z.array(z.string().max(500)).optional().transform((a) => a?.slice(0, 8)),
  note: z.string().max(400).optional(),
});

export type EmailIdentity = z.infer<typeof identitySchema> & {
  email: string;
  contacts?: Contact;
};

export interface EmailLookupOptions {
  anthropicApiKey?: string;
  model?: string;
  onProgress?: OnProgress;
  signal?: AbortSignal;
}

const toolInputSchema = zodToJsonSchema(identitySchema, {
  $refStrategy: "none",
  target: "openApi3",
}) as Record<string, unknown>;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Identify the owner of one email address from the open web. */
export async function researchEmail(
  email: string,
  opts: EmailLookupOptions = {},
): Promise<EmailIdentity> {
  const address = email.trim().toLowerCase();
  if (!EMAIL_RE.test(address)) throw new Error(`not an email address: ${email}`);
  const apiKey = opts.anthropicApiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      "Missing Anthropic API key. Set ANTHROPIC_API_KEY (get one at https://console.anthropic.com) or pass opts.anthropicApiKey.",
    );
  }

  const { output } = await callStructured<unknown>({
    client: new Anthropic({ apiKey }),
    model: opts.model,
    systemPrompt: SYSTEM_PROMPT,
    userMessage: `# Email address\n${address}\n\nIdentify the owner and call record_email_identity.`,
    toolName: "record_email_identity",
    toolDescription:
      "Record who the email address belongs to: the person (only when citable), their company, LinkedIn profile, any other published contact details, confidence, and sources.",
    toolInputSchema,
    cacheSystem: true,
    webSearch: true,
    webSearchMaxUses: 5,
    webFetch: true,
    webFetchMaxUses: 4,
    maxTokens: 1500,
    onProgress: opts.onProgress,
    signal: opts.signal,
  });

  return { ...identitySchema.parse(output), email: address };
}
