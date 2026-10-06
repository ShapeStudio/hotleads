# Latency benchmarks

Real API calls against one fixed seller input; each run costs roughly $0.25–0.50 and 1–7 minutes. Results land in `bench/out/` (gitignored) and a one-line summary is appended to `out/summary.jsonl` / `out/research-summary.jsonl`.

```bash
export ANTHROPIC_API_KEY=...
pnpm exec tsx bench/search-bench.mts staged direct-medium      # named variants, in order
pnpm exec tsx bench/block-probe.mts '{"output_config":{"effort":"low"}}' effort-low   # raw stream, every block timed
pnpm exec tsx bench/research-bench.mts r-direct-high r-direct-medium
```

Run-to-run variance is large (the same configuration has measured 166 s and 426 s), so interleave variants and only trust effects of 2× or more.

Findings that set the engine defaults (2026-10-06): Sonnet 5 thinks adaptively at the API-default high effort and that was 60% of a search call; `output_config.effort: "medium"` plus `allowed_callers: ["direct"]` on the web tools took a search from 166–426 s to 61–90 s. The staged search (`search-staged.ts`) then took it to 47–68 s with the full lead count.
