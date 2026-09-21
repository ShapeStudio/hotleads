// TypeSafe AI "System One" transport — the Jev family of calibrated decision
// models. Plain fetch, no SDK dependency: this package is published, and its
// consumers should not be forced onto an early-access vendor's client. The
// three question constructors below are JSON builders; the wire format is the
// whole integration.
//
// Jev answers questions ABOUT a state object. It has no web access and emits
// no strings — it decides, it does not research or write. Everything here is
// therefore judgment about data we already hold.

/** Anything JSON-serializable can be the state or an instruction. */
export type EntryType = string | number | boolean | null | object;

export type NoulQuestion = { type: "noul"; instructions?: EntryType };
export type ScoreQuestion = { type: "score"; instructions: EntryType; criteria: (string | null)[] };
export type ChoiceQuestion = {
  type: "choice";
  instructions: EntryType;
  criteria: Record<string, string | null>;
};
export type Question = NoulQuestion | ScoreQuestion | ChoiceQuestion;

/** A yes/no question. The answer is a probability, not a boolean. */
export const noul = (instructions?: EntryType): NoulQuestion => ({
  type: "noul",
  ...(instructions === undefined ? {} : { instructions }),
});

/**
 * An ordered rubric. The ARRAY INDEX is the score — `criteria[0]` describes a
 * 0, `criteria[10]` describes a 10 — and entries may be null where a level
 * needs no description. At least two levels.
 */
export const score = (instructions: EntryType, criteria: (string | null)[]): ScoreQuestion => ({
  type: "score",
  instructions,
  criteria,
});

/** Named alternatives, mapped to descriptions (or null for bare labels). */
export const choice = (
  instructions: EntryType,
  criteria: Record<string, string | null>,
): ChoiceQuestion => ({ type: "choice", instructions, criteria });

export type NoulAnswer = { type: "noul"; noul: number };
export type ScoreAnswer = {
  type: "score";
  score: number;
  confidence: number;
  probabilities: Record<string, number>;
};
export type ChoiceAnswer = {
  type: "choice";
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
};
export type Answer = NoulAnswer | ScoreAnswer | ChoiceAnswer;

export type SystemOneResult = {
  model: string;
  answers: Record<string, Answer>;
  usage?: { input_tokens: number; output_tokens: number };
};

/**
 * The one seam every caller goes through. Injectable so tests can answer
 * without a network or a key, and so an app can swap in the official SDK
 * without this package taking the dependency.
 */
export type SystemOneCaller = (
  body: { state: EntryType; questions: Record<string, Question>; model?: string },
  signal?: AbortSignal,
) => Promise<unknown>;

export const DEFAULT_JEV_MODEL = "jev-latest";
const DEFAULT_BASE_URL = "https://api.typesafe.ai";
const DEFAULT_TIMEOUT_MS = 5_000;

export interface TypeSafeOptions {
  /** Defaults to process.env.TYPESAFE_API_KEY. Absent = the scorer no-ops. */
  apiKey?: string;
  /** Defaults to process.env.TYPESAFE_BASE_URL, then api.typesafe.ai. */
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
  /** Override the transport entirely — tests and SDK-backed apps. */
  call?: SystemOneCaller;
  signal?: AbortSignal;
}

/**
 * Build the default fetch-backed caller. Returns null when no key is
 * configured, which is how the whole feature stays dormant: callers treat a
 * null caller as "no opinion" rather than an error.
 */
export function systemOneCaller(opts: TypeSafeOptions): SystemOneCaller | null {
  if (opts.call) return opts.call;
  const apiKey = opts.apiKey ?? process.env.TYPESAFE_API_KEY;
  if (!apiKey) return null;
  const baseUrl = opts.baseUrl ?? process.env.TYPESAFE_BASE_URL ?? DEFAULT_BASE_URL;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return async (body, signal) => {
    // Our own deadline, combined with the caller's cancellation. An
    // early-access endpoint that hangs must not hold up a search round.
    const timer = new AbortController();
    const t = setTimeout(() => timer.abort(), timeoutMs);
    const onAbort = () => timer.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const res = await fetch(`${baseUrl.replace(/\/$/, "")}/v1/systemone`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: timer.signal,
      });
      if (!res.ok) throw new Error(`systemone ${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(t);
      signal?.removeEventListener("abort", onAbort);
    }
  };
}

/** True when a real System One call could be made right now. */
export const typesafeConfigured = (opts: TypeSafeOptions = {}): boolean =>
  Boolean(opts.call ?? opts.apiKey ?? process.env.TYPESAFE_API_KEY);

/** Narrow an unknown response body to the answers we asked for. */
export function parseSystemOne(body: unknown): SystemOneResult | null {
  if (!body || typeof body !== "object") return null;
  const b = body as { model?: unknown; answers?: unknown; usage?: unknown };
  if (typeof b.model !== "string") return null;
  if (!b.answers || typeof b.answers !== "object") return null;
  const answers: Record<string, Answer> = {};
  for (const [name, raw] of Object.entries(b.answers as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object") continue;
    const a = raw as Record<string, unknown>;
    if (a.type === "noul" && typeof a.noul === "number") {
      answers[name] = { type: "noul", noul: a.noul };
    } else if (a.type === "score" && typeof a.score === "number") {
      answers[name] = {
        type: "score",
        score: a.score,
        confidence: typeof a.confidence === "number" ? a.confidence : 0,
        probabilities: (a.probabilities ?? {}) as Record<string, number>,
      };
    } else if (a.type === "choice" && typeof a.choice === "string") {
      answers[name] = {
        type: "choice",
        choice: a.choice,
        confidence: typeof a.confidence === "number" ? a.confidence : 0,
        probabilities: (a.probabilities ?? {}) as Record<string, number>,
      };
    }
  }
  return {
    model: b.model,
    answers,
    usage: b.usage as SystemOneResult["usage"],
  };
}
