# hotleads

**Deep prospect research on any decision-maker — and prospect search from your own company URL. Structured JSON out.**

One command runs a research agent that works through up to 15 targeted web searches — the person, their company, its global and home-market competitors, funding, news, hiring, traffic, pricing, and published contact details — and returns a single validated JSON dossier you can pipe anywhere. A LinkedIn URL is the strongest anchor, but it isn't required: `--name` + `--company` works for the many owners and directors who simply aren't on LinkedIn. Don't have a prospect list yet? [`hotleads search`](#prospect-search) starts from your own website and finds one.

```bash
export ANTHROPIC_API_KEY=sk-ant-…
npx hotleads https://www.linkedin.com/in/zigakerec/ --company-url https://www.shape-labs.com
```

```jsonc
{
  "person": {
    "full_name": "Žiga Kerec",
    "current_role": { "title": "Founder & CTO", "company": "Shape (shape-labs.com)" },
    "recent_activity_themes": ["AI-native product development and agentic coding", "Venture studio model and co-building on equity terms"]
    // … headline, location, about, education, past_experience, skills, social_links
  },
  "company": {
    "name": "SHAPE",
    "domain": "shape-labs.com",
    "hq_location": "Ljubljana, Slovenia (also Berlin & New York)",
    "funding": { "total_raised_estimate": "Not publicly disclosed; no formal rounds found" },
    "hiring_signals": { "actively_hiring": false, "note": "Studio appears lean by design." },
    "recent_news": [{ "title": "Shape publishes 'agentic coding' editorial series", "why_it_matters": "Positioning for inbound from founder/operator buyers in 2026." }]
    // … summary, industry, founded_year, products, positioning, tech_stack
  },
  "competitors": [
    { "name": "Altar.io", "note": "Product studio building MVPs for startups…", "vs_positioning": "Shape runs its own products in production — proof-of-practice vs. pure services…" }
  ],
  "commercials": {
    "pricing_model": "project + retainer B2B, equity co-builds",
    "typical_price_points": ["Process automation: cuts ops cost from ~€2,000/mo to ~€300/mo"]
    // … web_traffic_estimate + numeric twins for downstream math
  },
  "contact": {
    "emails": [{ "value": "hello@shape-labs.com", "label": "general inbox", "source_url": "https://www.shape-labs.com/contact" }],
    "phones": [{ "value": "+386 …", "label": "company switchboard", "source_url": "https://www.shape-labs.com/contact" }]
    // … address, contact_pages, social_profiles, note — published-and-cited only
  },
  "outreach": {
    "likely_pain_points": ["Standing out against cheap offshore dev shops…"],
    "hooks": ["Every automation Shape sells has already survived production on its own P&L…"],
    "icebreakers": ["Saw the agentic-coding series — how much of Shape's client work ships through Claude Code these days?"]
    // … role_summary, talking_points, tone_match
  },
  "meta": {
    "confidence": "medium",
    "sources": [{ "label": "Shape — official site", "url": "https://www.shape-labs.com" }],
    "searches_used": 10, "schema_version": "1"
    // … profile_accessible, research_notes, researched_at, model
  }
}
```

Full example (a real, unedited run on our own founder's profile): [`examples/sample-output.json`](examples/sample-output.json).

## Install & use

```bash
# one-off
npx hotleads <linkedin-url>

# or install
npm i -g hotleads
hotleads <linkedin-url> --pretty
```

**Single prospect**

```bash
hotleads https://linkedin.com/in/jane-doe --company-url https://acme.com
hotleads https://linkedin.com/in/jane-doe --json | jq '.outreach.hooks'
hotleads https://linkedin.com/in/jane-doe --depth deep --out jane.json
```

**No LinkedIn profile?** Anchor on the person's name and their company instead — the agent identifies them from the company site and public records, and never invents a profile URL to fill the gap.

```bash
hotleads --name "Jane Doe" --company "Acme d.o.o." --company-url https://acme.com
hotleads --name "Jane Doe" --company "Acme d.o.o." --json | jq '.contact'
```

**Batch (CSV)**

```bash
hotleads --csv prospects.csv --out results/ --concurrency 3
```

The CSV needs a `linkedin_url` column; `company_url`, `name`, `company`, `notes` are optional ([example](examples/prospects.example.csv)). One JSON file per prospect lands in `--out`; a bad row never aborts the batch (exit code `3` signals partial failure).

JSON goes to **stdout**, progress to **stderr** — pipe-safe by design.

## Prospect search

No list yet? Point `hotleads search` at **your own website**. It reads what you sell, commits to an ICP (ideal customer profile — industries, company sizes, geographies, buyer titles), then hunts for matching decision-makers at other companies across team pages, conference agendas, news, and public profile snippets.

```bash
hotleads search https://www.your-company.com --pretty
hotleads search https://acme.dev --target "Heads of RevOps at Series A-B SaaS in DACH"
hotleads search https://acme.dev --count 8 --research --out prospects/
```

```jsonc
{
  "icp": {
    "what_they_sell": "…grounded in your actual site, so you can sanity-check the inference…",
    "buyer_titles": ["Founder / CEO", "CTO", "VP of Product"],
    "target_industries": ["B2B SaaS", "E-commerce & retail"],
    "icp_source": "inferred"          // "provided" when you pass --target
    // … category, target_company_size, target_geographies, buying_triggers
  },
  "prospects": [
    {
      "full_name": "…", "title": "…", "company": "…",
      "linkedin_url": "…",            // ONLY when the URL actually appeared in a
                                      // search result — never constructed from a name
      "why_relevant": "…ties back to the icp block…",
      "source_url": "…",              // required: the page where name + role were seen
      "signals": ["…funding, hiring, launches — reasons to reach out now…"],
      "confidence": "high"            // high | medium | low, criteria in the docs
    }
  ],
  "meta": { "sources": [{ "label": "…", "url": "…" }], "searches_used": 14, "schema_version": "1" }
}
```

- `--target` skips ICP inference and adopts your own description — the sharpest results come from one good sentence about who you sell to.
- Prospects found on team pages, business registers, or conference listings often have no profile URL attached. A targeted lookup pass then searches for each one specifically (`--no-profile-lookup` to skip it) — still refusing to guess: people it can't find stay empty rather than getting a plausible dead link.
- `--research` chains every prospect that has a verified `linkedin.com/in` URL straight into the full research pipeline: with `--out <dir>` you get `search.json` plus one dossier file per prospect; without it, one combined JSON envelope on stdout. Prospects without an observed URL are skipped and reported, never guessed.
- Fewer results than `--count` is intentional honesty: every listed person must be citable via `source_url`.

The sample fixture [`examples/sample-search-output.json`](examples/sample-search-output.json) has a **real ICP inference** for our own site, but the prospect entries are **fictionalized** (invented people and `.example` domains) — we don't publish real third-party people in a git repo. Run it on your own site to see the real thing.

## Library

```ts
import { research, researchMany, prospectResearchSchema } from "hotleads";

const dossier = await research(
  { linkedin_url: "https://linkedin.com/in/jane-doe", company_url: "https://acme.com" },
  { depth: "standard", onProgress: (e) => console.error(e) },
);
// dossier is fully typed (ProspectResearch) and already validated
```

`researchMany(inputs, { concurrency })` runs a bounded pool with per-row error isolation. The zod schemas (`prospectResearchSchema`, `researchInputSchema`, `prospectSearchSchema`, `searchInputSchema`) are exported — validate stored dossiers, generate types, build on top.

Search-then-research is a two-liner:

```ts
import { searchProspects, researchMany } from "hotleads";

const found = await searchProspects({ company_url: "https://acme.com", count: 10 });
const dossiers = await researchMany(
  found.prospects
    .filter((p) => p.linkedin_url)
    .map((p) => ({ linkedin_url: p.linkedin_url!, name: p.full_name, company: p.company })),
  { concurrency: 3 },
);
```

## Keys & cost

| Key | Required | What it does |
|---|---|---|
| `ANTHROPIC_API_KEY` | yes | Runs the research agent (Claude + web search). [console.anthropic.com](https://console.anthropic.com) |
| `PROXYCURL_API_KEY` | no | Verified LinkedIn profile data — rescues member-gated profiles. [nubela.co/proxycurl](https://nubela.co/proxycurl) |

Keys load from env vars or a `.env` in the working directory. **Approximate cost per prospect** (you pay your providers directly, we take nothing):

| Command | Depth | Web searches | Typical cost |
|---|---|---|---|
| research | `standard` | up to 15 | ~$0.35–0.50 |
| research | `deep` | up to 19 | ~$0.55–0.70 |
| search | `standard` | up to 14 (+ profile lookup) | ~$0.45–0.70 |
| search | `deep` | up to 18 (+ profile lookup) | ~$0.70–1.00 |

Made of: Anthropic tokens, web-search fees ($0.01/search), optional Proxycurl (~$0.01, research only). Runs also make a few direct page fetches (your site, team pages) — fetches have no per-use fee; the fetched content bills as normal input tokens.

## How it sources data

The agent uses **public web search and direct page fetches** (plus Proxycurl's API if you provide a key). Any URL you provide — your own site in `search`, `--company-url` in research — is **fetched directly**, so it grounds the research even when the site isn't indexed by any search engine. It does not log into LinkedIn, does not scrape behind auth walls, and marks everything unverifiable as an estimate with its basis — or leaves it empty. `meta.sources` lists every page that informed the dossier; `meta.confidence` and `meta.research_notes` tell you how much to trust it. In prospect search, LinkedIn profile URLs are included **only when they actually appeared in retrieved results** — never constructed from a name — and every prospect carries the `source_url` where their name and role were seen. A follow-up pass searches specifically for the profiles the main search couldn't cite, under the same rule: found or empty, never guessed.

The `contact` block follows the same discipline. Every address and number is one the agent actually read on a public page, carrying the `source_url` it came from — company contact and imprint pages, business registers, conference listings. It never derives an address from a name pattern (`first.last@company.com`) or from a colleague's address: guessed addresses mostly bounce, and bounces damage your sending domain. When a person publishes nothing, the block stays empty and `contact.note` says so.

## Schema stability

The output shape is versioned via `meta.schema_version` (currently `"1"`). Breaking shape changes bump it alongside a major package release.

## What's next

Personalized one-pagers and sales decks generated from this research + your own uploaded deck — the research layer you're holding is the foundation. Watch this repo.

## License

[MIT](LICENSE) · built by [SHAPE](https://www.shape-labs.com) · [hotleads.si](https://hotleads.si)
