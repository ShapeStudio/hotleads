// hotleads CLI — deep prospect research from any LinkedIn URL,
// and prospect search from your own company URL.
//
//   npx hotleads <linkedin-url> [--company-url <url>] [--depth standard|deep]
//   npx hotleads --csv prospects.csv --out results/ --concurrency 3
//   npx hotleads search <your-company-url> [--target <icp>] [--research]
//
// JSON goes to stdout (pipe-friendly); all progress goes to stderr.
// Exit codes: 0 ok · 1 usage/config error · 2 total failure · 3 partial failure
// (some batch rows or chained dossiers failed).

import { parseArgs } from "node:util";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { config as loadDotenv } from "dotenv";
import { research } from "../research.js";
import { researchMany } from "../batch.js";
import { searchProspects } from "../search.js";
import type { ResearchDepth } from "../research.js";
import type { ProspectSearch, ResearchInput } from "../schema.js";
import { parseProspectsCsv } from "./csv.js";
import { makeProgressRenderer, log, ok, fail } from "./progress.js";

loadDotenv();

const HELP = `hotleads — prospect research and prospect search. Structured JSON out.

Usage:
  hotleads <linkedin-url> [options]          research one prospect
  hotleads --name <person> --company <org>   research someone with no LinkedIn
  hotleads --csv <file> --out <dir> [opts]   research a CSV of prospects
  hotleads search <your-company-url> [opts]  find prospects from your own site

Research options:
  --company-url <url>    the prospect company's website (anchors company research)
  --name <person>        person's name — required when there's no LinkedIn URL
  --company <org>        their company — required when there's no LinkedIn URL
  --notes <text>         anything you already know — feeds the research
  --csv <file>           batch mode: CSV with a linkedin_url column
                         (optional columns: company_url, name, company, notes)
  --depth <d>            standard (15 searches, default) | deep (19 searches)

Search options:
  --target <text>        describe your ideal customer yourself (skips inference)
  --count <n>            prospects to find (default 10, max 25)
  --research             chain every prospect with a verified linkedin.com/in
                         URL into a full research dossier
  --no-profile-lookup    skip the pass that finds LinkedIn URLs for prospects
                         the search couldn't cite one for (saves a few searches)
  --notes <text>         extra context on what you sell
  --location <city>      only decision-makers whose company can be placed
                         in or around this city (verified, cited)
  --depth <d>            standard (14 searches, default) | deep (18 searches)

Shared options:
  --model <id>           Anthropic model id (default claude-sonnet-5)
  --out <file|dir>       write JSON to a file (or a directory in batch/--research)
  --concurrency <n>      parallel dossiers in batch / --research mode (default 3)
  --json                 compact JSON output (default when piped)
  --pretty               pretty-printed JSON (default on a TTY)
  --quiet                no progress output
  -h, --help             show this help
  -v, --version          show version

Environment:
  ANTHROPIC_API_KEY      required — https://console.anthropic.com
  PROXYCURL_API_KEY      optional — verified LinkedIn data for gated profiles

Examples:
  hotleads https://www.linkedin.com/in/zigakerec/ --pretty
  hotleads --name "Sabina Juhart" --company "xPLUS d.o.o." --company-url https://xplus.si
  hotleads --csv prospects.csv --out results/ --concurrency 3
  hotleads search https://www.your-company.com --pretty
  hotleads search https://acme.dev --target "Heads of RevOps at Series A-B SaaS in DACH"
  hotleads search https://acme.dev --count 8 --research --out prospects/
`;

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "prospect"
  );
}

/** "acme.com" → "https://acme.com"; anything that isn't a clean root domain → undefined. */
function domainToUrl(domain: string | undefined): string | undefined {
  return domain && /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i.test(domain)
    ? `https://${domain}`
    : undefined;
}

type CliValues = {
  "company-url"?: string;
  name?: string;
  company?: string;
  notes?: string;
  depth?: string;
  model?: string;
  csv?: string;
  out?: string;
  concurrency?: string;
  target?: string;
  location?: string;
  count?: string;
  research?: boolean;
  "no-profile-lookup"?: boolean;
  json?: boolean;
  pretty?: boolean;
  quiet?: boolean;
  help?: boolean;
  version?: boolean;
};

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      "company-url": { type: "string" },
      name: { type: "string" },
      company: { type: "string" },
      notes: { type: "string" },
      depth: { type: "string" },
      model: { type: "string" },
      csv: { type: "string" },
      out: { type: "string" },
      concurrency: { type: "string" },
      target: { type: "string" },
      location: { type: "string" },
      count: { type: "string" },
      research: { type: "boolean" },
      "no-profile-lookup": { type: "boolean" },
      json: { type: "boolean" },
      pretty: { type: "boolean" },
      quiet: { type: "boolean" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });

  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (values.version) {
    // package.json is bundled one level above dist/cli/
    const pkg = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    ) as { version: string };
    process.stdout.write(pkg.version + "\n");
    return 0;
  }

  const depth = (values.depth ?? "standard") as ResearchDepth;
  if (depth !== "standard" && depth !== "deep") {
    fail(`--depth must be "standard" or "deep", got "${values.depth}"`);
    return 1;
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    fail(
      "ANTHROPIC_API_KEY is not set.\n  Get a key at https://console.anthropic.com and either:\n    export ANTHROPIC_API_KEY=sk-ant-…\n  or put it in a .env file in this directory.",
    );
    return 1;
  }

  const pretty = values.pretty ?? (process.stdout.isTTY && !values.json);
  const serialize = (obj: unknown) =>
    pretty ? JSON.stringify(obj, null, 2) : JSON.stringify(obj);

  // ---- search mode ---------------------------------------------------------
  if (positionals[0] === "search") {
    return runSearch(values, positionals, depth, serialize);
  }

  // ---- batch mode ----------------------------------------------------------
  if (values.csv) {
    if (!existsSync(values.csv)) {
      fail(`CSV not found: ${values.csv}`);
      return 1;
    }
    let inputs: ResearchInput[];
    try {
      inputs = parseProspectsCsv(readFileSync(values.csv, "utf8"));
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
      return 1;
    }
    if (inputs.length === 0) {
      fail("CSV has no data rows");
      return 1;
    }
    const outDir = values.out ?? "results";
    mkdirSync(outDir, { recursive: true });
    const concurrency = Number(values.concurrency ?? 3) || 3;

    log(`researching ${inputs.length} prospects (concurrency ${concurrency})…`);
    const results = await researchMany(inputs, {
      depth,
      model: values.model,
      concurrency,
      onRow: (r, done, total) => {
        if (r.ok) {
          const name = r.result.person.full_name;
          const file = join(outDir, `${slugify(name)}.json`);
          writeFileSync(file, serialize(r.result) + "\n");
          ok(`[${done}/${total}] ${name} → ${file}`);
        } else {
          fail(`[${done}/${total}] ${r.input.linkedin_url}: ${r.error}`);
        }
      },
    });

    const failures = results.filter((r) => !r.ok).length;
    log("");
    log(`done: ${results.length - failures} ok, ${failures} failed`);
    if (failures === results.length) return 2;
    if (failures > 0) return 3;
    return 0;
  }

  // ---- single mode ---------------------------------------------------------
  // Identify by profile URL, or by --name + --company for the many real
  // decision-makers who simply aren't on LinkedIn.
  const linkedinUrl = positionals[0];
  if (!linkedinUrl && !(values.name && values.company)) {
    if (values.name || values.company) {
      fail("--name and --company must be used together when there's no LinkedIn URL");
      return 1;
    }
    process.stderr.write(HELP);
    return 1;
  }

  try {
    const result = await research(
      {
        linkedin_url: linkedinUrl,
        company_url: values["company-url"],
        name: values.name,
        company: values.company,
        notes: values.notes,
      },
      {
        depth,
        model: values.model,
        onProgress: makeProgressRenderer(!!values.quiet),
      },
    );
    const out = serialize(result) + "\n";
    if (values.out) {
      writeFileSync(values.out, out);
      ok(`written to ${values.out}`);
    } else {
      process.stdout.write(out);
    }
    return 0;
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
    return 2;
  }
}

// ---- prospect search -------------------------------------------------------

async function runSearch(
  values: CliValues,
  positionals: string[],
  depth: ResearchDepth,
  serialize: (obj: unknown) => string,
): Promise<number> {
  const rawUrl = positionals[1];
  if (!rawUrl) {
    process.stderr.write(HELP);
    return 1;
  }
  // Friendly to bare domains: "acme.com" → "https://acme.com".
  const companyUrl = /^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`;

  const count = values.count === undefined ? 10 : Number(values.count);
  if (!Number.isInteger(count) || count < 1 || count > 25) {
    fail(`--count must be an integer between 1 and 25, got "${values.count}"`);
    return 1;
  }

  let search: ProspectSearch;
  try {
    search = await searchProspects(
      {
        company_url: companyUrl,
        target: values.target,
        notes: values.notes,
        location: values.location,
        count,
      },
      {
        depth,
        model: values.model,
        resolveLinkedinUrls: !values["no-profile-lookup"],
        onProgress: makeProgressRenderer(!!values.quiet, "writing prospect list…"),
      },
    );
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
    return 2;
  }

  // ---- plain search: one ProspectSearch JSON --------------------------------
  if (!values.research) {
    const out = serialize(search) + "\n";
    if (values.out) {
      writeFileSync(values.out, out);
      ok(`written to ${values.out}`);
    } else {
      process.stdout.write(out);
    }
    return 0;
  }

  // ---- --research: chain found prospects into full dossiers -----------------
  const withUrl = search.prospects.filter((p) => p.linkedin_url);
  const skipped = search.prospects.filter((p) => !p.linkedin_url);
  if (skipped.length > 0) {
    log(
      `${skipped.length} of ${search.prospects.length} prospects had no verified LinkedIn URL — skipped`,
    );
  }

  const outDir = values.out;
  if (outDir) {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, "search.json"), serialize(search) + "\n");
    ok(`search → ${join(outDir, "search.json")}`);
  }

  if (withUrl.length === 0) {
    log("no prospects to research");
    if (!outDir) {
      const envelope = {
        search,
        dossiers: skipped.map((p) => ({
          prospect: p.full_name,
          ok: false,
          skipped: true,
          reason: "no verified linkedin_url",
        })),
      };
      process.stdout.write(serialize(envelope) + "\n");
    }
    return 0;
  }

  const inputs: ResearchInput[] = withUrl.map((p) => ({
    linkedin_url: p.linkedin_url!,
    company_url: domainToUrl(p.company_domain),
    name: p.full_name,
    company: p.company,
    notes: p.why_relevant,
  }));
  const concurrency = Number(values.concurrency ?? 3) || 3;

  log(`researching ${inputs.length} prospects (concurrency ${concurrency})…`);
  const results = await researchMany(inputs, {
    depth,
    model: values.model,
    concurrency,
    onRow: (r, done, total) => {
      if (r.ok) {
        const name = r.result.person.full_name;
        if (outDir) {
          const file = join(outDir, `${slugify(name)}.json`);
          writeFileSync(file, serialize(r.result) + "\n");
          ok(`[${done}/${total}] ${name} → ${file}`);
        } else {
          ok(`[${done}/${total}] ${name}`);
        }
      } else {
        fail(`[${done}/${total}] ${r.input.linkedin_url}: ${r.error}`);
      }
    },
  });

  const failures = results.filter((r) => !r.ok).length;
  log("");
  log(`done: ${results.length - failures} dossiers ok, ${failures} failed, ${skipped.length} skipped`);

  if (!outDir) {
    // researchMany results are index-aligned with inputs/withUrl.
    const envelope = {
      search,
      dossiers: [
        ...results.map((r, i) =>
          r.ok
            ? {
                prospect: withUrl[i]!.full_name,
                linkedin_url: withUrl[i]!.linkedin_url,
                ok: true as const,
                dossier: r.result,
              }
            : {
                prospect: withUrl[i]!.full_name,
                linkedin_url: withUrl[i]!.linkedin_url,
                ok: false as const,
                error: r.error,
              },
        ),
        ...skipped.map((p) => ({
          prospect: p.full_name,
          ok: false as const,
          skipped: true,
          reason: "no verified linkedin_url",
        })),
      ],
    };
    process.stdout.write(serialize(envelope) + "\n");
  }

  return failures > 0 ? 3 : 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    fail(err instanceof Error ? err.message : String(err));
    process.exit(2);
  },
);
