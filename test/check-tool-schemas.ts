/**
 * Regression test: the zod schema we hand to the Anthropic API as a tool
 * input_schema must be valid JSON Schema draft 2020-12 — Anthropic validates
 * against that dialect and rejects the whole request otherwise.
 *
 * Exists because z.number().positive() under zod-to-json-schema's openApi3
 * target emits `exclusiveMinimum: true` (boolean — OpenAPI 3.0 dialect),
 * which took every research call down in production with:
 *   400 tools.0.custom.input_schema: JSON schema is invalid
 *
 * Rule: numbers use .min(0), never .positive(). Run via `pnpm test`.
 */

import { Ajv2020 } from "ajv/dist/2020.js";
import { zodToJsonSchema } from "zod-to-json-schema";
import { prospectSearchToolSchema, researchToolSchema } from "../src/schema.js";
import { lookupToolSchema } from "../src/linkedin-lookup.js";
import { introToolSchema } from "../src/company-intro.js";
import { alternateLookupToolSchema } from "../src/alternate-lookup.js";
import { sweepToolSchema } from "../src/contact-sweep.js";

const TOOL_SCHEMAS = [
  ["record_research", researchToolSchema],
  ["record_prospect_search", prospectSearchToolSchema],
  ["record_profile_urls", lookupToolSchema],
  ["record_intro", introToolSchema],
  ["record_alternates", alternateLookupToolSchema],
  ["record_contacts", sweepToolSchema],
] as const;

const ajv = new Ajv2020({ strict: false, validateFormats: false });

let failed = false;

for (const [name, schema] of TOOL_SCHEMAS) {
  const emitted = zodToJsonSchema(schema as never, {
    $refStrategy: "none",
    target: "openApi3",
  });
  try {
    ajv.compile(emitted as never);
    console.log(`✓ ${name}`);
  } catch (err) {
    failed = true;
    console.error(`✗ ${name}`);
    console.error(`  ${err instanceof Error ? err.message : err}`);
  }

  // Belt-and-suspenders for the exact bug class Ajv's lenient mode could
  // let through: boolean exclusiveMinimum/Maximum (OpenAPI 3.0 dialect).
  const raw = JSON.stringify(emitted);
  const booleanExclusive = raw.match(/"exclusive(Minimum|Maximum)":\s*(true|false)/g);
  if (booleanExclusive) {
    failed = true;
    console.error(
      `✗ ${name}: boolean exclusiveMinimum/Maximum (OpenAPI 3.0-ism) — Anthropic will 400`,
    );
  }
}

if (failed) {
  console.error("\nTool schema check FAILED.");
  process.exit(1);
}
console.log("All tool schemas are draft-2020-12 clean.");
