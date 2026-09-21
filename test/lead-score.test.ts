import { strict as assert } from "node:assert";
import { test } from "node:test";
import { scoreLeads, rankKey, SCORER_VERSION } from "../src/lead-score.js";
import type { IcpProfile, ProspectLead } from "../src/schema.js";
import type { SystemOneCaller } from "../src/typesafe.js";

// Every test injects a caller, so nothing here touches the network or needs
// a key. The point of these is the DEGRADE contract: a scorer that throws,
// or that returns a short array, breaks a search round — and a search round
// is the thing users paid for.

const icp: IcpProfile = {
  company_name: "Acme",
  what_they_sell: "A tool for X",
  buyer_titles: ["Head of Sales"],
  icp_source: "inferred",
} as IcpProfile;

const lead = (name: string): ProspectLead =>
  ({
    full_name: name,
    title: "Head of Sales",
    company: "Corp",
    why_relevant: "runs the team that would buy this",
    source_url: "https://example.com",
    confidence: "high",
  }) as ProspectLead;

const okAnswer = {
  model: "jev-latest",
  answers: {
    fit: { type: "score", score: 7.4, confidence: 0.8, probabilities: {} },
    decision_maker: { type: "noul", noul: 0.9 },
    reachable: { type: "noul", noul: 0.6 },
  },
};

const callerReturning = (body: unknown): SystemOneCaller => async () => body;

test("empty input returns empty and never calls the model", async () => {
  let calls = 0;
  const out = await scoreLeads([], icp, {
    call: async () => {
      calls++;
      return okAnswer;
    },
  });
  assert.deepEqual(out, []);
  assert.equal(calls, 0);
});

test("unconfigured scorer yields all nulls, one per lead", async () => {
  const prev = process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
  try {
    const leads = [lead("A"), lead("B"), lead("C")];
    const out = await scoreLeads(leads, icp);
    assert.equal(out.length, 3);
    assert.ok(out.every((s) => s === null));
  } finally {
    if (prev !== undefined) process.env.TYPESAFE_API_KEY = prev;
  }
});

test("happy path parses the shape and clamps into range", async () => {
  const out = await scoreLeads([lead("A")], icp, { call: callerReturning(okAnswer) });
  const s = out[0];
  assert.ok(s, "expected a score");
  assert.equal(s.fit, 7.4);
  assert.equal(s.decision_maker, 0.9);
  assert.equal(s.reachable, 0.6);
  assert.equal(s.scorer, "jev");
  assert.equal(s.v, SCORER_VERSION);
  assert.ok(s.fit >= 0 && s.fit <= 10);
});

test("out-of-range numbers are clamped rather than trusted", async () => {
  const out = await scoreLeads([lead("A")], icp, {
    call: callerReturning({
      model: "jev-latest",
      answers: {
        fit: { type: "score", score: 99, confidence: 1, probabilities: {} },
        decision_maker: { type: "noul", noul: 1.7 },
        reachable: { type: "noul", noul: -0.3 },
      },
    }),
  });
  assert.equal(out[0]?.fit, 10);
  assert.equal(out[0]?.decision_maker, 1);
  assert.equal(out[0]?.reachable, 0);
});

for (const [label, caller] of [
  ["a rejecting caller", (async () => {
    throw new Error("boom");
  }) as SystemOneCaller],
  ["garbage", callerReturning("not json at all")],
  ["null", callerReturning(null)],
  ["a body with no answers", callerReturning({ model: "jev-latest" })],
  ["answers of the wrong type", callerReturning({
    model: "jev-latest",
    answers: {
      fit: { type: "noul", noul: 0.5 },
      decision_maker: { type: "noul", noul: 0.5 },
      reachable: { type: "noul", noul: 0.5 },
    },
  })],
  ["a partial answer set", callerReturning({
    model: "jev-latest",
    answers: { fit: { type: "score", score: 5, confidence: 1, probabilities: {} } },
  })],
] as const) {
  test(`${label} yields null, never a throw`, async () => {
    const out = await scoreLeads([lead("A")], icp, { call: caller });
    assert.equal(out.length, 1);
    assert.equal(out[0], null);
  });
}

test("output stays aligned with input when only some leads score", async () => {
  // The alignment invariant: callers zip this against their own array, so a
  // dropped or reordered entry would attach a score to the wrong person.
  const leads = [lead("A"), lead("B"), lead("C"), lead("D"), lead("E")];
  const call: SystemOneCaller = async (body) => {
    const state = body.state as { lead: { company: string } };
    void state;
    const n = seen++;
    if (n % 2 === 1) throw new Error("every other one fails");
    return okAnswer;
  };
  let seen = 0;
  const out = await scoreLeads(leads, icp, { call, concurrency: 1 });
  assert.equal(out.length, leads.length);
  assert.ok(out[0] !== null);
  assert.equal(out[1], null);
  assert.ok(out[2] !== null);
  assert.equal(out[3], null);
  assert.ok(out[4] !== null);
});

test("rankKey sorts unscored last, not as zero", async () => {
  const scored = (await scoreLeads([lead("A")], icp, { call: callerReturning(okAnswer) }))[0];
  const weak = (
    await scoreLeads([lead("B")], icp, {
      call: callerReturning({
        model: "jev-latest",
        answers: {
          fit: { type: "score", score: 0, confidence: 1, probabilities: {} },
          decision_maker: { type: "noul", noul: 0 },
          reachable: { type: "noul", noul: 0 },
        },
      }),
    })
  )[0];
  assert.ok(rankKey(scored ?? null) > rankKey(weak ?? null));
  // A zero-fit lead we DID look at still outranks one we never scored.
  assert.ok(rankKey(weak ?? null) > rankKey(null));
});
