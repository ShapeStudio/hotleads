// Calibrated fit scoring for leads, via TypeSafe's Jev model.
//
// This answers a question nothing in the pipeline answered before: "is this a
// good lead FOR THIS SELLER." The existing `confidence` field is often read
// that way, but it means something else entirely — how sure the search model
// is that the person holds the stated role. The two come apart in practice:
// in production, high-confidence leads are archived ~3x more often than
// medium-confidence ones. Certainty about a fact is not fit.
//
// Contract, copied from linkedin-lookup.ts and contact-sweep.ts: this NEVER
// throws and NEVER blocks a search round. Unconfigured, slow, down, or
// malformed all produce `null` — "no opinion" — and every caller must treat
// null as exactly today's behavior. A wrong score is worse than no score,
// because a score gets trusted.

import {
  noul,
  parseSystemOne,
  score,
  systemOneCaller,
  DEFAULT_JEV_MODEL,
  type Question,
  type TypeSafeOptions,
} from "./typesafe.js";
import type { IcpProfile, ProspectLead } from "./schema.js";

/**
 * Bump on ANY change to the questions, the rubric, or the state shape.
 *
 * Stored alongside every score. A threshold is only meaningful for the
 * scorer that produced the numbers it was tuned on, so a consumer that acts
 * on a score must check this first — otherwise editing a rubric silently
 * re-points a validated threshold at a different distribution.
 */
export const SCORER_VERSION = 1;

export type LeadScore = {
  /** 0-10, interpolated between rubric levels. Ordering, not a verdict. */
  fit: number;
  /** P(this person can actually approve a purchase). */
  decision_maker: number;
  /** P(there is a workable route to contact them). */
  reachable: number;
  scorer: "jev";
  model: string;
  scored_at: string;
  v: number;
};

export interface LeadScoreOptions extends TypeSafeOptions {
  /** Parallel calls in flight. Matches the contact sweep's concurrency. */
  concurrency?: number;
}

const DEFAULT_CONCURRENCY = 4;

/**
 * The rubric. Index = score, so this array has 11 entries and the described
 * levels are the anchors the model interpolates between. Only the anchors
 * carry text — describing every level invites false precision.
 */
const FIT_RUBRIC: (string | null)[] = [
  "Not a prospect at all: wrong industry, or the person does not plausibly exist in a buying role for this product.",
  null,
  "Weak: right industry at best, but the role has no connection to the problem this product solves.",
  null,
  "Marginal: plausible company, but the person is junior to the buying decision or the fit rests on a generic justification.",
  null,
  "Reasonable: company matches the target profile and the role is adjacent to the buying decision.",
  null,
  "Strong: company squarely in the target profile, and the role is one of the stated buyer titles.",
  null,
  "Ideal: stated buyer title at a company matching the target profile, with a concrete, cited reason this seller is relevant to them right now.",
];

/**
 * Only the fields that bear on fit. Deliberately NOT the whole lead: passing
 * `confidence` would let a role-certainty signal leak into a fit judgment,
 * which is the exact conflation this scorer exists to undo.
 */
function stateFor(lead: ProspectLead, icp: IcpProfile) {
  return {
    seller: {
      sells: icp.what_they_sell,
      category: icp.category,
      target_industries: icp.target_industries,
      target_company_size: icp.target_company_size,
      target_geographies: icp.target_geographies,
      buyer_titles: icp.buyer_titles,
      buying_triggers: icp.buying_triggers,
    },
    lead: {
      title: lead.title,
      seniority: lead.seniority,
      department: lead.department,
      company: lead.company,
      location: lead.location,
      // The search model's own justification — the thing most worth
      // second-guessing, since a vague one usually means a weak lead.
      claimed_relevance: lead.why_relevant,
      signals: lead.signals,
      has_linkedin: Boolean(lead.linkedin_url),
      has_company_domain: Boolean(lead.company_domain),
    },
  };
}

const QUESTIONS: Record<string, Question> = {
  fit: score(
    "How well does this lead match what the seller sells and who they sell to? Judge the MATCH, not how certain you are that the person exists. A specific, cited reason this seller matters to this company scores higher than a generic one.",
    FIT_RUBRIC,
  ),
  decision_maker: noul(
    "Could this person approve a purchase of the seller's product, or is approval clearly above them?",
  ),
  reachable: noul(
    "Is there a workable route to contact this person — a profile, a company domain, or a role public enough to have published contact details?",
  ),
};

/**
 * Score leads against the ICP they were found for.
 *
 * Returns one entry per input lead, positionally aligned, `null` where no
 * opinion could be formed. Callers rely on that alignment — see the test.
 */
export async function scoreLeads(
  leads: ProspectLead[],
  icp: IcpProfile,
  opts: LeadScoreOptions = {},
): Promise<(LeadScore | null)[]> {
  if (leads.length === 0) return [];
  const call = systemOneCaller(opts);
  if (!call) return leads.map(() => null);

  const model = opts.model ?? DEFAULT_JEV_MODEL;
  const out: (LeadScore | null)[] = new Array(leads.length).fill(null);
  const concurrency = Math.max(1, opts.concurrency ?? DEFAULT_CONCURRENCY);

  // One call per lead, four questions per call. Batching LEADS into a single
  // state would make each score conditional on its neighbours — that turns
  // absolute scoring into relative ranking, losing the calibration that is
  // the entire reason for using this model.
  for (let i = 0; i < leads.length; i += concurrency) {
    const chunk = leads.slice(i, i + concurrency);
    const scored = await Promise.all(
      chunk.map(async (lead, j) => {
        try {
          const raw = await call(
            { state: stateFor(lead, icp), questions: QUESTIONS, model },
            opts.signal,
          );
          const parsed = parseSystemOne(raw);
          if (!parsed) return null;
          const fit = parsed.answers.fit;
          const dm = parsed.answers.decision_maker;
          const reach = parsed.answers.reachable;
          // All three or nothing: a partial answer set means the rubric and
          // the response have drifted apart, and a half-scored lead would
          // still sort as if it were fully judged.
          if (fit?.type !== "score" || dm?.type !== "noul" || reach?.type !== "noul") return null;
          return {
            index: i + j,
            value: {
              fit: Math.round(Math.min(10, Math.max(0, fit.score)) * 10) / 10,
              decision_maker: clamp01(dm.noul),
              reachable: clamp01(reach.noul),
              scorer: "jev" as const,
              model: parsed.model,
              scored_at: new Date().toISOString(),
              v: SCORER_VERSION,
            },
          };
        } catch {
          // No opinion. Scoring is an enhancement, never a dependency —
          // the same contract contact enrichment has.
          return null;
        }
      }),
    );
    for (const entry of scored) if (entry) out[entry.index] = entry.value;
  }
  return out;
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/**
 * Ranking key. `fit` leads; the two probabilities break ties, because a
 * perfect-fit person who cannot approve a purchase and cannot be contacted is
 * a wasted dossier. Unscored leads sort last rather than as zero — "we never
 * looked" is not "we looked and it's bad".
 */
export function rankKey(s: LeadScore | null): number {
  if (!s) return -1;
  return s.fit + s.decision_maker * 0.5 + s.reachable * 0.5;
}
