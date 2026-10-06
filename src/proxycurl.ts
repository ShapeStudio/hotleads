// Proxycurl person-profile client — the optional verified-data layer on top
// of web-search research. When a key is provided we fetch structured profile
// facts (name, headline, role, company, education, experience) and hand them
// to the researcher as ground truth. This rescues profiles that are gated to
// logged-in LinkedIn members, which public web search can't see.
//
// Docs: https://nubela.co/proxycurl/docs#people-api-person-profile-endpoint
// Cost: ~1 credit (~$0.01) per call on the cached-first path.

const ENDPOINT = "https://nubela.co/proxycurl/api/v2/linkedin";
const MAX_ATTEMPTS = 2;
// This fetch runs BEFORE the research call starts, so its worst case is pure
// added latency: two 20 s attempts put a dossier 40 s behind before the
// model had seen a byte. Proxycurl's own cache answers in well under 8 s;
// anything slower is better abandoned for the web-only budget.
const ATTEMPT_TIMEOUT_MS = 8_000;

export type ProxycurlExperience = {
  starts_at?: { day?: number; month?: number; year?: number } | null;
  ends_at?: { day?: number; month?: number; year?: number } | null;
  company?: string | null;
  title?: string | null;
  description?: string | null;
  location?: string | null;
};

export type ProxycurlEducation = {
  starts_at?: { year?: number } | null;
  ends_at?: { year?: number } | null;
  field_of_study?: string | null;
  degree_name?: string | null;
  school?: string | null;
};

export type ProxycurlProfile = {
  public_identifier?: string | null;
  profile_pic_url?: string | null;
  full_name?: string | null;
  headline?: string | null;
  summary?: string | null;
  country?: string | null;
  city?: string | null;
  state?: string | null;
  occupation?: string | null;
  experiences?: ProxycurlExperience[] | null;
  education?: ProxycurlEducation[] | null;
  skills?: string[] | null;
};

/**
 * Look up a LinkedIn profile by URL. Returns null when:
 *   - no API key was provided (this is a soft-fallback layer)
 *   - the URL doesn't look like a LinkedIn profile
 *   - Proxycurl errors after retries, or the profile doesn't exist
 *
 * Never throws — research falls through to the web-search-only path.
 */
export async function fetchProxycurlProfile(
  linkedinUrl: string,
  apiKey: string | undefined,
): Promise<ProxycurlProfile | null> {
  if (!apiKey) return null;
  if (!/linkedin\.com\/in\//i.test(linkedinUrl)) return null;

  const url = new URL(ENDPOINT);
  url.searchParams.set("linkedin_profile_url", linkedinUrl);
  // Cheapest viable path: cached data when fresh; fall back to cache if the
  // live fetch errors upstream.
  url.searchParams.set("use_cache", "if-recent");
  url.searchParams.set("fallback_to_cache", "on-error");

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
      });
      if (res.ok) return (await res.json()) as ProxycurlProfile;
      if (res.status === 404) return null; // profile doesn't exist — no retry
      // 429/5xx → retry once, then give up softly.
    } catch {
      // network error / timeout — retry, then give up softly
    }
  }
  return null;
}
