import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeCompanyResults, parseExcluded } from "../src/search-staged.js";
import type { ProspectLead } from "../src/schema.js";

const lead = (full_name: string, company: string): ProspectLead => ({
  full_name,
  title: "CEO",
  company,
  why_relevant: "fits",
  source_url: "https://example.com/team",
  confidence: "high",
});

test("merge interleaves companies so the first picks span companies", () => {
  const out = mergeCompanyResults(
    [[lead("A1", "A"), lead("A2", "A")], [lead("B1", "B")], [lead("C1", "C"), lead("C2", "C")]],
    4,
  );
  assert.deepEqual(out.map((p) => p.full_name), ["A1", "B1", "C1", "A2"]);
});

test("merge dedupes the same person reported twice", () => {
  const out = mergeCompanyResults([[lead("Jane Doe", "Acme")], [lead("jane doe", "ACME")]], 5);
  assert.equal(out.length, 1);
});

test("merge stops at count and tolerates empty companies", () => {
  const out = mergeCompanyResults([[], [lead("B1", "B"), lead("B2", "B")], []], 1);
  assert.deepEqual(out.map((p) => p.full_name), ["B1"]);
});

test("exclusions split into names and companies", () => {
  const ex = parseExcluded(["Jane Doe (Acme GmbH)", "John Smith", "Žiga K (Shape)"]);
  assert.ok(ex.names.has("jane doe"));
  assert.ok(ex.names.has("john smith"));
  assert.ok(ex.names.has("ziga k"));
  assert.ok(ex.companies.has("acme gmbh"));
  assert.ok(ex.companies.has("shape"));
  assert.equal(ex.companies.size, 2);
});
