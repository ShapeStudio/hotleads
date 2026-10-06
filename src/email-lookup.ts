// Reverse email lookup: who owns this address? Searches the exact address,
// reads the domain's site (team/about/imprint pages), and returns the person
// ONLY when a citable page ties them to the address or its local part.
// Same honesty contract as the rest of the engine: found or empty — never a
// guess. A generic-provider address (gmail…) with no exact-match hits is a
// legitimate "not found".

import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { callStructured, type OnProgress, type OnUsage } from "./anthropic.js";
import { contactSchema, type Contact } from "./schema.js";

const SYSTEM_PROMPT = `You are an identity researcher. Input: one email address. Output: who it belongs to — recorded via the record_email_identity tool. Only report what a page you actually read supports.

Method:
1. web_search the EXACT address in quotes ("name@company.com") — signatures, imprints, directories, conference bios, press releases.
2. Parse the domain. If it's a company domain, ALWAYS web_fetch the site's people pages (/team, /about, /contact, /impressum, /o-nas, /uber-uns — adapt to language) AND search "<local-part> <domain>" and "<company> team"; match the LOCAL PART against listed people (jan.novak@ / dan@ → the Jan Novak or Dan listed on the team page is a match). Fetch the actual page — do not decide from search snippets. info@ / office@ match the COMPANY, not a person.
3. Generic providers (gmail, outlook, yahoo…): the local part usually ENCODES a name OR a business — derive candidates ("melaniegossweiner187" → Melanie Gossweiner; "jimmy.rozier" → Jimmy Rozier; "kepplertim3" → Tim Keppler; "baschisbaudienstleistungen" → a business "Baschis Bau-Dienstleistungen", search it as a COMPANY). Trailing digits are often a birth year. Search the derived name/business AND fetch the top matching page to confirm — be thorough, not hasty.
4. If you identify the person, one targeted search for their LinkedIn profile URL ("<name>" "<company>" linkedin) — record it only when the profile plainly matches.

Rules:
- Company-domain addresses: found=true ONLY when a citable source ties the address (or its local part on that domain) to a named person.
- Derived-name identifications (generic providers): found=true is allowed WITHOUT an exact-address hit when the derived name resolves to ONE clear public person — a distinctive name with a coherent public footprint. Cap confidence at "medium", and say in note that the name was derived from the address. If several distinct people plausibly match and nothing disambiguates, found=false with the ambiguity named in note.
- A role address (info@, office@, sales@) identifies the COMPANY: set found=false for the person but fill company when the domain's site confirms it, and say so in note.
- Record every claim's source URL in sources.
- contacts: OTHER published details for the person/company you saw along the way (labeled, sourced) — never pattern-guessed.
- confidence: "high" (page shows the address or local-part match on the exact domain), "medium" (strong indirect or derived-name match), "low" (weak signals — prefer found=false over low-confidence guesses).`;

// Free-text fields truncate instead of failing the whole parse — the same
// clip() stance as schema.ts: a verbose model must never sink a result.
const clip = (max: number) =>
  z.string().transform((s) => (s.length > max ? `${s.slice(0, max - 1)}…` : s));

const DEEP_SYSTEM_PROMPT = `You are an identity researcher on a SECOND, deeper pass: a first pass found nothing for this email address. Attack from different angles — recorded via the record_email_identity tool. Only report what a page you actually read supports.

Angles (pick the promising ones, be decisive):
1. The LOCAL PART as a USERNAME — people reuse handles across platforms. Search it bare and with platform hints ("cimitahiri1991", "cimitahiri1991" instagram OR facebook OR github OR x OR tiktok).
2. Name variants — reversed ordering (gossweinermelanie → Gossweiner Melanie AND Melanie Gossweiner), nicknames (jimmy→James, tim→Timothy, beti→Elisabeth), diacritics the ASCII form may hide (novak → Novák/Novak).
3. Country hints — the TLD, the language of any hits, digits that look like phone prefixes or birth years: search the derived name plus the hinted country/city, and that country's people directories or business registries.
4. The exact address in documents — signatures leak into PDFs and filings (search the address plus filetype or "pdf").

Be PERSISTENT: this is the deep pass, so actually FETCH the promising pages (LinkedIn/company/registry/directory profiles), don't judge from snippets, and cross-reference two independent sources before concluding. Exhaust the angles before giving up.

Rules (same honesty contract as the first pass):
- found=true only when the evidence converges on ONE coherent person; confidence at most "medium", and the note must explain the derivation chain.
- Several plausible people and nothing to disambiguate → found=false, ambiguity named in note.
- A username match on a platform is only an identification when the profile carries a real name.
- Record every claim's source URL in sources. Never pattern-guess contact details.`;

const identitySchema = z.object({
  found: z.boolean(),
  person: z
    .object({
      full_name: clip(120),
      title: clip(160).optional(),
      location: clip(120).optional(),
    })
    .optional(),
  company: z
    .object({
      name: clip(160).optional(),
      domain: clip(160).optional(),
    })
    .optional(),
  linkedin_url: z.string().max(300).optional().catch(undefined),
  contacts: contactSchema.optional(),
  confidence: z.enum(["high", "medium", "low"]).optional().catch(undefined),
  sources: z.array(clip(500)).optional().transform((a) => a?.slice(0, 8)),
  note: clip(400).optional(),
});

export type EmailIdentity = z.infer<typeof identitySchema> & {
  email: string;
  contacts?: Contact;
};

export interface EmailLookupOptions {
  anthropicApiKey?: string;
  model?: string;
  onProgress?: OnProgress;
  /** Token accounting, one call per model call. Telemetry only — see anthropic.ts. */
  onUsage?: OnUsage;
  signal?: AbortSignal;
  /** Second-pass mode: different angles, bigger search budget. */
  deep?: boolean;
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

  const { output, usage } = await callStructured<unknown>({
    client: new Anthropic({ apiKey }),
    model: opts.model,
    systemPrompt: opts.deep ? DEEP_SYSTEM_PROMPT : SYSTEM_PROMPT,
    userMessage: `# Email address\n${address}\n\nIdentify the owner and call record_email_identity.`,
    toolName: "record_email_identity",
    toolDescription:
      "Record who the email address belongs to: the person (only when citable), their company, LinkedIn profile, any other published contact details, confidence, and sources.",
    toolInputSchema,
    cacheSystem: true,
    webSearch: true,
    webSearchMaxUses: opts.deep ? 14 : 8,
    webFetch: true,
    webFetchMaxUses: opts.deep ? 12 : 8,
    // Up to 12 fetches here — at the 15k default that is a context nobody
    // needs for a signature block, a contact page or a LinkedIn snippet.
    maxContentTokens: 6000,
    maxTokens: 2500,
    onProgress: opts.onProgress,
    signal: opts.signal,
  });

  opts.onUsage?.(usage);

  return { ...identitySchema.parse(output), email: address };
}
