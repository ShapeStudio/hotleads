import { strict as assert } from "node:assert";
import { test } from "node:test";
import { formatSellerProfile } from "../src/search.js";
import { searchInputSchema } from "../src/schema.js";
import { clipText } from "../src/company-intro.js";

// The profile is how a seller's corrections reach every future search, so the
// rendering is worth pinning: an empty profile must render NOTHING (otherwise
// the search is told to "adopt" a blank ICP), and every filled field must
// survive into the prompt.

test("an empty profile renders nothing", () => {
  assert.equal(formatSellerProfile({}), "");
  assert.equal(
    formatSellerProfile({ what_they_sell: "  ", buyer_titles: ["", "  "], notes: "" }),
    "",
  );
});

test("every filled field reaches the prompt block", () => {
  const out = formatSellerProfile({
    what_they_sell: "OCR bookkeeping for accounting firms",
    category: "AP automation",
    buyer_titles: ["Firm owner", "Managing partner"],
    target_industries: ["Accounting services"],
    target_company_size: "1-20 staff",
    target_geographies: ["Slovenia", "Croatia"],
    buying_triggers: ["Moving to e-invoicing"],
    notes: "Skip the big four.",
  });
  for (const needle of [
    "OCR bookkeeping for accounting firms",
    "AP automation",
    "Firm owner; Managing partner",
    "Accounting services",
    "1-20 staff",
    "Slovenia; Croatia",
    "Moving to e-invoicing",
    "Skip the big four.",
  ]) {
    assert.ok(out.includes(needle), `missing: ${needle}`);
  }
});

test("search input accepts a profile and still accepts none", () => {
  assert.ok(searchInputSchema.safeParse({ company_url: "https://a.com" }).success);
  assert.ok(
    searchInputSchema.safeParse({
      company_url: "https://a.com",
      profile: { buyer_titles: ["CFO"] },
    }).success,
  );
});

test("researched text is clipped at a word boundary, never mid-word", () => {
  const long =
    "Small to medium businesses and solo proprietors that issue and receive invoices regularly and work with an accountant";
  const out = clipText(long, 60);
  assert.ok(out.length <= 60, `too long: ${out.length}`);
  assert.ok(out.endsWith("…"));
  assert.ok(long.startsWith(out.slice(0, -1)), "cut must be a prefix");
  assert.equal(long[out.length - 1], " ", "cut must land on a word boundary");
  assert.equal(clipText("short", 60), "short");
});
