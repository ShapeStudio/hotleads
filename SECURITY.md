# Security Policy

## Reporting a vulnerability

Please report security issues privately via
[GitHub Security Advisories](https://github.com/ShapeStudio/hotleads/security/advisories/new)
or email **hello@shape-labs.com**. Do not open a public issue for
security-sensitive reports. We aim to respond within 72 hours.

## Scope & design notes

- **Your API keys never leave your machine** except to the providers they
  belong to: `ANTHROPIC_API_KEY` is sent only to `api.anthropic.com` (via the
  official SDK) and `PROXYCURL_API_KEY` only to `nubela.co`. There is no
  telemetry, no analytics, and no HotLeads server involved in a CLI run.
- Keys are read from environment variables or a local `.env`; they are never
  written to disk, logged, or included in the JSON output.
- Research output can contain personal data about the researched prospect
  (that's the product). Treat generated dossiers as personal data under your
  local regulations (e.g. GDPR) — you are the data controller for what you
  research and store.

## Supported versions

Only the latest published version receives security fixes.
