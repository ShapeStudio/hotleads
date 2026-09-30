import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  normalizeMetaField,
  prospectResearchSchema,
  researchToolSchema,
  researchInputSchema,
  prospectSearchSchema,
  prospectSearchToolSchema,
  prospectLeadSchema,
  searchInputSchema,
  stripNulls,
  truncate,
  assessReachability,
} from "../src/schema.js";
import { parseProspectsCsv, parseCsv } from "../src/cli/csv.js";
import { nameFromLinkedinUrl } from "../src/research.js";

test("sample-output.json parses against prospectResearchSchema", () => {
  const sample = JSON.parse(
    readFileSync(new URL("../examples/sample-output.json", import.meta.url), "utf8"),
  );
  const parsed = prospectResearchSchema.parse(sample);
  assert.equal(typeof parsed.person.full_name, "string");
  assert.ok(parsed.outreach.hooks.length >= 1);
  assert.equal(typeof parsed.meta.researched_at, "string");
});

test("tool schema accepts a minimal model output", () => {
  const minimal = {
    person: { full_name: "Jane Doe" },
    outreach: {
      role_summary: "Mid-market operator",
      likely_pain_points: ["manual research"],
      hooks: ["automation angle"],
    },
  };
  const parsed = researchToolSchema.parse(minimal);
  assert.equal(parsed.person.full_name, "Jane Doe");
});

test("truncate cuts at a word boundary and stays inside the budget", () => {
  // The live case: a model answering founded_year with more than a year.
  assert.equal(truncate("2003 (incorporated)", 12), "2003…");
  // Nothing to cut.
  assert.equal(truncate("2003", 12), "2003");
  // No boundary to fall back to — a hard cut is still better than failing.
  assert.equal(truncate("x".repeat(40), 12), `${"x".repeat(11)}…`);
  // Dangling punctuation left by the cut is dropped.
  assert.equal(truncate("Accounting services, tax advisory", 22), "Accounting services…");
  for (const [text, max] of [
    ["2003 (incorporated)", 12],
    ["x".repeat(40), 12],
    ["Accounting services, tax advisory", 22],
  ] as const) {
    assert.ok(truncate(text, max).length <= max, `${text} @ ${max}`);
  }
});

test("tool schema truncates over-long strings instead of failing", () => {
  const parsed = researchToolSchema.parse({
    person: { full_name: "x".repeat(500) },
    outreach: {
      role_summary: "y".repeat(2000),
      likely_pain_points: ["p"],
      hooks: ["h"],
    },
  });
  assert.equal(parsed.person.full_name.length, 120);
  assert.equal(parsed.outreach.role_summary.length, 300);
});

test("tool schema caps over-long arrays instead of failing", () => {
  const parsed = researchToolSchema.parse({
    person: { full_name: "Jane" },
    competitors: Array.from({ length: 12 }, (_, i) => ({
      name: `Comp ${i}`,
      note: "note",
    })),
    outreach: {
      role_summary: "r",
      likely_pain_points: Array.from({ length: 12 }, (_, i) => `pain ${i}`),
      hooks: ["h"],
    },
  });
  assert.equal(parsed.competitors?.length, 5);
  assert.equal(parsed.outreach.likely_pain_points.length, 5);
});

test("null-emitting model output parses after stripNulls (live-run regression)", () => {
  // An early live run failed on "personal_site": null before stripNulls
  // existed — models emit explicit nulls for unfillable optional fields.
  const modelOutput = {
    person: {
      full_name: "Jane Doe",
      headline: null,
      social_links: { twitter: null, github: null, personal_site: null },
      education: null,
    },
    company: null,
    outreach: {
      role_summary: "r",
      likely_pain_points: ["p"],
      hooks: ["h"],
      tone_match: null,
    },
    meta: { confidence: "medium", sources: null },
  };
  const parsed = researchToolSchema.parse(stripNulls(modelOutput));
  assert.equal(parsed.person.full_name, "Jane Doe");
  assert.equal(parsed.person.headline, undefined);
  assert.equal(parsed.company, undefined);
});

test("input schema rejects non-LinkedIn URLs", () => {
  assert.throws(() => researchInputSchema.parse({ linkedin_url: "https://example.com/x" }));
  assert.doesNotThrow(() =>
    researchInputSchema.parse({ linkedin_url: "https://www.linkedin.com/in/jane-doe/" }),
  );
});

test("input schema accepts name + company as an anchor when there's no profile", () => {
  assert.doesNotThrow(() =>
    researchInputSchema.parse({ name: "Sabina Juhart", company: "xPLUS d.o.o." }),
  );
  // Half an anchor is not an anchor — a bare name can't be pinned to a person.
  assert.throws(() => researchInputSchema.parse({ name: "Sabina Juhart" }));
  assert.throws(() => researchInputSchema.parse({ company: "xPLUS d.o.o." }));
  assert.throws(() => researchInputSchema.parse({ company_url: "https://xplus.si" }));
});

test("tool schema takes published contact details and caps them", () => {
  const parsed = researchToolSchema.parse({
    person: { full_name: "Jane Doe" },
    contact: {
      emails: Array.from({ length: 9 }, (_, i) => ({
        value: `info${i}@acme.example`,
        label: "info inbox",
        source_url: "https://acme.example/contact",
      })),
      phones: [{ value: "+386 1 234 5678", label: "company switchboard" }],
      contact_pages: ["https://acme.example/contact"],
      note: "No personal address published anywhere.",
    },
    outreach: { role_summary: "r", likely_pain_points: ["p"], hooks: ["h"] },
  });
  assert.equal(parsed.contact?.emails?.length, 5);
  assert.equal(parsed.contact?.phones?.[0]?.value, "+386 1 234 5678");
  assert.equal(parsed.contact?.contact_pages?.length, 1);
});

test("nameFromLinkedinUrl derives a pretty name and drops hash suffixes", () => {
  assert.equal(
    nameFromLinkedinUrl("https://www.linkedin.com/in/ziga-kerec-72b3a8"),
    "Ziga Kerec",
  );
  assert.equal(nameFromLinkedinUrl("not a url"), "Unknown");
});

test("csv parser handles quotes, commas, CRLF", () => {
  const rows = parseCsv('a,"b,1","c""q"\r\nd,e,f\n');
  assert.deepEqual(rows, [
    ["a", "b,1", 'c"q'],
    ["d", "e", "f"],
  ]);
});

// ---- prospect search --------------------------------------------------------

test("sample-search-output.json parses against prospectSearchSchema", () => {
  const sample = JSON.parse(
    readFileSync(
      new URL("../examples/sample-search-output.json", import.meta.url),
      "utf8",
    ),
  );
  const parsed = prospectSearchSchema.parse(sample);
  assert.ok(parsed.icp.buyer_titles.length >= 1);
  assert.ok(parsed.prospects.length >= 1);
  assert.equal(typeof parsed.meta.searched_at, "string");
  assert.ok(["inferred", "provided"].includes(parsed.icp.icp_source));
});

test("search tool schema accepts a minimal model output", () => {
  const parsed = prospectSearchToolSchema.parse({
    icp: {
      company_name: "Acme",
      what_they_sell: "Developer tooling for platform teams.",
      buyer_titles: ["VP Engineering"],
    },
    prospects: [],
  });
  assert.equal(parsed.prospects.length, 0);
});

test("search tool schema truncates and caps instead of failing", () => {
  const lead = {
    full_name: "Jane Doe",
    title: "VP Ops",
    company: "Acme",
    why_relevant: "w".repeat(2000),
    source_url: "https://acme.example/team",
    confidence: "high",
  };
  const parsed = prospectSearchToolSchema.parse({
    icp: {
      company_name: "Acme",
      what_they_sell: "s",
      buyer_titles: Array.from({ length: 12 }, (_, i) => `Title ${i}`),
    },
    prospects: Array.from({ length: 30 }, () => ({ ...lead })),
  });
  assert.equal(parsed.icp.buyer_titles.length, 8);
  assert.equal(parsed.prospects.length, 25);
  assert.equal(parsed.prospects[0]?.why_relevant.length, 400);
});

test("null-emitting search output parses after stripNulls", () => {
  const modelOutput = {
    icp: {
      company_name: "Acme",
      company_domain: null,
      what_they_sell: "s",
      buyer_titles: ["CTO"],
      buying_triggers: null,
    },
    prospects: [
      {
        full_name: "Jane Doe",
        title: "CTO",
        company: "Beta GmbH",
        linkedin_url: null,
        location: null,
        why_relevant: "matches ICP",
        source_url: "https://beta.example/about",
        signals: null,
        confidence: "medium",
      },
    ],
    meta: { confidence: "medium", sources: null },
  };
  const parsed = prospectSearchToolSchema.parse(stripNulls(modelOutput));
  assert.equal(parsed.prospects[0]?.linkedin_url, undefined);
  assert.equal(parsed.icp.company_domain, undefined);
});

test("prospect linkedin_url keeps /in/ profiles and drops everything else", () => {
  const base = {
    full_name: "Jane Doe",
    title: "VP Ops",
    company: "Acme",
    why_relevant: "matches ICP",
    source_url: "https://acme.example/team",
    confidence: "high",
  };
  const kept = prospectLeadSchema.parse({
    ...base,
    linkedin_url: "https://www.linkedin.com/in/jane-doe/",
  });
  assert.equal(kept.linkedin_url, "https://www.linkedin.com/in/jane-doe/");
  for (const bad of [
    "https://www.linkedin.com/company/acme",   // company page
    "https://example.com/in/jane",             // wrong host
    "https://evil-linkedin.com/in/jane",       // lookalike host
    "not a url",
  ]) {
    const parsed = prospectLeadSchema.parse({ ...base, linkedin_url: bad });
    assert.equal(parsed.linkedin_url, undefined, `should drop: ${bad}`);
  }
});

test("string meta is salvaged as research_notes (live-run regression)", () => {
  // A live knjigovid.si run emitted meta as a prose string, which failed the
  // whole parse before normalizeMetaField existed.
  const modelOutput = {
    icp: {
      company_name: "Acme",
      what_they_sell: "s",
      buyer_titles: ["CTO"],
    },
    prospects: [],
    meta: "Site was hard to verify; ICP grounded in the fetched homepage.",
  };
  const parsed = prospectSearchToolSchema.parse(
    normalizeMetaField(stripNulls(modelOutput)),
  );
  assert.equal(
    parsed.meta?.research_notes,
    "Site was hard to verify; ICP grounded in the fetched homepage.",
  );

  // A JSON-encoded meta string is recovered as the actual object.
  const jsonMeta = {
    ...modelOutput,
    meta: JSON.stringify({ confidence: "high", research_notes: "clean run" }),
  };
  const parsed2 = prospectSearchToolSchema.parse(
    normalizeMetaField(stripNulls(jsonMeta)),
  );
  assert.equal(parsed2.meta?.confidence, "high");
  assert.equal(parsed2.meta?.research_notes, "clean run");

  // Other non-object metas are dropped, not failed.
  const numericMeta = { ...modelOutput, meta: 42 };
  const parsed3 = prospectSearchToolSchema.parse(
    normalizeMetaField(stripNulls(numericMeta)),
  );
  assert.equal(parsed3.meta, undefined);
});

test("search input schema validates url and count bounds", () => {
  assert.doesNotThrow(() =>
    searchInputSchema.parse({ company_url: "https://acme.com", count: 25 }),
  );
  assert.throws(() => searchInputSchema.parse({ company_url: "not a url" }));
  assert.throws(() => searchInputSchema.parse({ company_url: "https://acme.com", count: 0 }));
  assert.throws(() => searchInputSchema.parse({ company_url: "https://acme.com", count: 26 }));
});

test("search input caps the exclude list instead of failing", () => {
  const parsed = searchInputSchema.parse({
    company_url: "https://acme.com",
    exclude: Array.from({ length: 120 }, (_, i) => `Person ${i} (Co ${i})`),
  });
  assert.equal(parsed.exclude?.length, 80);
});

test("prospects csv requires linkedin_url header and maps optional columns", () => {
  const rows = parseProspectsCsv(
    "linkedin_url,company_url,name\nhttps://linkedin.com/in/a,https://a.com,Ann\nhttps://linkedin.com/in/b,,\n",
  );
  assert.equal(rows.length, 2);
  assert.equal(rows[0]?.company_url, "https://a.com");
  assert.equal(rows[1]?.name, undefined);
  assert.throws(() => parseProspectsCsv("name\nAnn\n"), /linkedin_url/);
});

test("assessReachability: gated profile + only company inboxes = unreachable", () => {
  const r = assessReachability({
    person: { full_name: "Rafael Hymann", linkedin_url: "https://linkedin.com/in/rafael" },
    contact: {
      emails: [{ value: "team@horizn.com", label: "general team@ inbox", reach: "company" }],
      phones: [],
    },
    meta: { profile_accessible: false },
  });
  assert.equal(r.reachable, false);
  assert.match(r.reason ?? "", /member-gated/);
  assert.match(r.reason ?? "", /shared company routes/);
});

test("assessReachability: accessible profile is a channel", () => {
  const r = assessReachability({
    person: { full_name: "Ann Lee", linkedin_url: "https://linkedin.com/in/annlee" },
    meta: {},
  });
  assert.equal(r.reachable, true);
  assert.deepEqual(r.channels, ["linkedin"]);
});

test("assessReachability: direct email counts, with or without the reach field", () => {
  const tagged = assessReachability({
    person: { full_name: "Ann Lee" },
    contact: { emails: [{ value: "a.lee@acme.com", reach: "direct" }] },
  });
  assert.deepEqual(tagged.channels, ["direct_email"]);
  // Pre-`reach` dossiers: fall back to the label naming the person.
  const legacy = assessReachability({
    person: { full_name: "Ann Lee" },
    contact: { emails: [{ value: "a.lee@acme.com", label: "direct — Ann Lee" }] },
  });
  assert.deepEqual(legacy.channels, ["direct_email"]);
});

test("assessReachability: nothing published at all names the gap", () => {
  const r = assessReachability({ person: { full_name: "Ann Lee" } });
  assert.equal(r.reachable, false);
  assert.match(r.reason ?? "", /no LinkedIn profile/);
  assert.match(r.reason ?? "", /no contact details published/);
});
