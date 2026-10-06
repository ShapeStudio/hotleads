/**
 * Does this LinkedIn profile URL plausibly belong to this person?
 *
 * The search prompt forbids constructing slugs, but a model reading a page
 * of snippets can still attach the URL from the neighbouring result to the
 * wrong name — observed in the wild as a Head of Sales carrying a stranger's
 * profile. A wrong URL is worse than none: the lead becomes unresearchable
 * and the seller messages the wrong person. The check is deliberately loose
 * (any name token, or an initial+surname form, anywhere in the slug), so it
 * only rejects URLs that share nothing with the name. Rejected URLs are
 * dropped, and the LinkedIn lookup pass gets another, stricter go at them.
 */
export function plausibleProfileUrl(fullName: string, url: string | undefined): url is string {
  if (!url) return false;
  const match = url.match(/linkedin\.com\/in\/([^/?#]+)/i);
  if (!match) return false;
  const slug = fold(match[1]!);
  const parts = fold(fullName)
    .split(/[^a-z0-9]+/)
    .filter((p) => p.length >= 2);
  // Nothing to judge against (single-letter or non-Latin name) — keep it:
  // this guard only ever removes URLs it can show are wrong.
  if (parts.length === 0) return true;
  if (parts.some((p) => slug.includes(p))) return true;
  if (parts.length >= 2) {
    const first = parts[0]!;
    const last = parts[parts.length - 1]!;
    // jsmith / smithj / j-smith style slugs.
    const initialForms = [first[0] + last, last + first[0], last[0] + first, first + last[0]];
    if (initialForms.some((f) => slug.includes(f))) return true;
  }
  return false;
}

/** Lowercase, strip diacritics, map the few letters NFKD leaves alone. */
function fold(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/ß/g, "ss")
    .replace(/[łŁ]/g, "l")
    .replace(/[øØ]/g, "o")
    .replace(/[đĐ]/g, "d")
    .replace(/æ/g, "ae")
    .replace(/œ/g, "oe");
}
