# The LLM-as-Judge Pattern

A practical guide to using an LLM as a tie-breaker instead of a primary classifier. Real numbers, real code, real pitfalls.

## The pattern in 30 seconds

Most decisions in a classification problem are easy. A handful are hard. **Cheap deterministic algorithms** decide the easy ones; **expensive LLMs** decide only the hard ones.

```
Input ──→ Deterministic scorer ──→ Decision:
                                    ├─ HIGH confidence → use it (free, ~0ms)
                                    ├─ LOW confidence → reject (free, ~0ms)
                                    └─ AMBIGUOUS → LLM judge (~$0.002, ~1.5s)
```

You pay LLM cost only on the ambiguous slice, which usually sits around 10–20% of the workload. The result is a system that's **as accurate as the LLM, as fast as the algorithm, and as cheap as the cache hit rate**.

In FOTECH's production matcher, this pattern brought **ambiguity from 11.5% down to 1.1%** in product matching while holding cost at ~$0.0019 per ambiguous decision.

## When it fits

The pattern works well when:

1. **A deterministic score correlates strongly with the right answer.** The LLM doesn't need to do the whole problem — just the close calls.
2. **The judgement is shallow.** The LLM sees a few candidates and picks one, plus a confidence and a reason. No deep multi-step reasoning needed.
3. **Errors have asymmetric cost.** False positives are expensive (corrupted data); false negatives are cheap (the admin reviews them). You want a binary "I'm sure" / "I'm not" gate, and the LLM is good at that.
4. **The domain has lexical equivalences that don't fit regex.** `TAB ≈ CAP only if everything else matches exactly`, `pediatric ≠ adult even if same molecule`, that kind of thing.

Places where it fits beyond pharma:

- Vendor catalog reconciliation
- ICD-10 / SNOMED clinical code lookup
- Marketplace product matching
- Legal citation disambiguation
- Customer-support ticket routing on the boundary cases

## When it doesn't fit

Skip this pattern when:

- **The deterministic scorer is bad.** If the algorithm can't reach 80%+ on the easy cases, most queries end up in the LLM and the cost savings evaporate.
- **You need multi-step reasoning.** The judge is supposed to make one shallow decision. If it has to chain five facts together, that's a different pattern (an agent, not a judge).
- **The answer has to be identical across all clients.** A judge with a custom prompt can be swayed by client-specific rules. If strict regulatory parity is a hard requirement, deterministic is safer.
- **Cost or latency doesn't matter.** If you can afford to call the LLM on every input, you might as well — fewer moving parts.

## Implementation

The full implementation is in [`src/matcher/juez-llm.js`](../src/matcher/juez-llm.js). The parts that matter:

### 1. The orchestrator decides whether to call the judge

```js
// src/matcher/matcher-v3-llm.js
const THRESHOLDS = {
  CLEAR_MATCH: 0.95,    // top1 ≥ this → match without LLM
  CLEAR_MARGIN: 0.20,   // top1 ≥ 0.80 AND beats #2 by this → match
  NEW: 0.15,            // top1 < this → new without LLM
};

async function decide({ invoiceLine, candidates, tenantId }) {
  const ranked = scoreLiteralAll(invoiceLine, candidates);
  const top1 = ranked[0];
  const margin = top1.score - (ranked[1]?.score ?? 0);

  if (top1.score >= THRESHOLDS.CLEAR_MATCH) return result('match', top1, 'score_direct_top1');
  if (top1.score >= 0.80 && margin >= THRESHOLDS.CLEAR_MARGIN) return result('match', top1, 'score_direct_margin');
  if (top1.score < THRESHOLDS.NEW) return result('new', null, 'score_new');

  // ambiguous — call judge with top 3
  const j = await judge.consult({ invoice: invoiceLine, candidates: ranked.slice(0, 3), tenantId });
  return interpretJudgement(j, ranked);
}
```

The threshold values come from running the eval suite and looking at score distributions at the boundaries. They're not free parameters — they're tuned empirically over 88 real invoices.

### 2. The judge is a strict JSON oracle

```js
// src/matcher/juez-llm.js (sanitized — full prompt private)
const SYSTEM_PROMPT = `You are a Mexican pharmaceutical expert. You decide whether an invoice line
corresponds to ONE product in the catalog, or if it's a new product. You reason like a pharmacist,
not a string-matcher.

PRESENTATION EQUIVALENCES (always synonyms):
  TAB = TABS = TABLETA = TABLETAS = COMP = COMPRIMIDO
  CAP = CAPS = CAPSULA = CAPSULAS
  SUSP = SUSPENSION
  ...

CLINICAL INTERCHANGEABILITY:
  TAB ≈ CAP (solid oral): ONLY if everything else matches exactly.
  SUSP ≠ SOL (different liquids).
  Different routes (OFT vs ORAL vs NASAL) = different products.

DIFFERENTIATORS (make it a different product):
  FORTE, PLUS, NF, DUO, PEDIATRICO, ADULTO, EXTRA, LP (extended release)
  Example: "DOLO-NEUROBION 1" ≠ "DOLO-NEUROBION FORTE"

HARD RULES:
  1. Concentration must match: 500MG ≠ 250MG
  2. Pack must match: c/10 ≠ c/20
  3. Brand must match (with normalization: "DOLFORT-DE" = "DOLFORT-D")
  4. Route must match
  5. Population must match (don't match pediatric to non-pediatric)

PARENTHETICALS in invoice:
  Often the active ingredient: "BENEVENTOL (CEFIXIMA)" → brand is BENEVENTOL
  Sometimes the lab: "BIPERIDENO (Psicofarma)" → brand is BIPERIDENO
  Never the primary commercial brand.

[4 worked examples follow]

Always respond in valid JSON, no extra text, no markdown.`;
```

Output shape is small and strict:

```json
{ "elegido": 1, "confianza": 98, "razon": "same brand, conc, pack, form; #2 differs in pack" }
```

`elegido` is `1 | 2 | 3 | "ninguno" | "ambiguo"` — the candidate number, or "none" (new product), or "ambiguous" (send to human review).

### 3. Cache by `(tenant + invoice + candidates + model)`

```js
function calculateHash(tenantId, invoice, candidates, model) {
  const candStr = candidates.map(c => c.name_in_db).join('||');
  // The model is in the hash so swapping Haiku → Gemini doesn't poison results.
  const payload = `${tenantId}|${invoice}|${candStr}|${model}`;
  return crypto.createHash('sha256').update(payload).digest('hex');
}
```

Putting the model in the hash means I can A/B test models without one poisoning the other's cache. The cache lives in PostgreSQL (one table, ~5 columns), so it survives restarts and gives me an audit log for free.

### 4. Kill switch on insufficient budget

```js
if (status === 402 || errorMessage.includes('insufficient') || errorMessage.includes('credit balance')) {
  _ABORT_OUT_OF_BUDGET = true;  // global flag — all subsequent calls short-circuit
  return { decision: 'ambiguous', reason: 'LLM out of budget — fell back to human review' };
}
```

Before this, a billing problem meant every line failed individually and the runner would still fire thousands of API calls. Now the first 402 trips a global flag and everything else returns a graceful fallback without hitting the API.

## Numbers from production

On the FOTECH matcher (88 invoices, partial run of 543 lines):

| Metric | Value |
|---|---|
| Cost per LLM call | $0.0019 (Claude Haiku 4.5) |
| Latency per LLM call | ~1.5s (p50), ~3.5s (p95) |
| Cache hit rate after warm-up | ~50% (climbing as the catalog stabilizes) |
| % of lines that need the judge | ~40% on this dataset (depends on supplier mix) |
| Ambiguity rate before pattern | 11.5% |
| Ambiguity rate with pattern | 1.1% |
| Cost reduction vs LLM-on-everything | ~60% (the algorithm handles 60% of lines for free) |

For a small client running 1,000 invoices/month at 25 lines each (25,000 lines), the LLM bill is around **$10-15/month**. For an enterprise at 100,000 lines/month, it scales linearly. The cache pushes the effective number lower over time as the same products keep showing up.

## Pitfalls I hit

### 1. The first prompt was too short

Version 1 of the system prompt was ~150 tokens with no examples. The judge was confidently wrong on the ambiguous calls. The fix was to **add 4 worked examples** at the end of the prompt covering the common edge cases (parentheticals, differentiators, route mismatches). The prompt grew to ~650 tokens and the decision quality jumped.

### 2. `temperature=0` is not optional

At `temperature=0.3` (the default), the same invoice line got different verdicts across runs. The cache started returning stale results because the same hash pointed to a decision written from a different roll of the dice. **Always temperature=0** for a judge.

### 3. Cache key needs the model

I shipped the first version without the model in the cache key. Then I A/B tested Haiku vs Gemini and Gemini's decisions started overwriting Haiku's entries. The cache was poisoned; I couldn't trust historical data. **Always put the model in the hash.**

### 4. Rate limits on the Vercel AI Gateway free tier

Vercel's "trial credit" doesn't bypass Anthropic's free-tier rate limits when calls are routed through their gateway. On a large batch run, I hit 429s after ~75 calls and the run died at 89% errors. Workarounds: use direct Anthropic for batch jobs, or pay for Vercel's regular tier (not the trial). Detect `HTTP 429` as a kill-switch trigger, not just `HTTP 402`.

### 5. The judge can hallucinate candidates

Ask the judge `"pick one of these 3 candidates, or say none"` and sometimes it will pick a fourth by inventing it. The fix: make the output enum-shaped (`1 | 2 | 3 | "none" | "ambiguous"`) and parse it strictly. If it doesn't match the enum, treat it as ambiguous.

## When to graduate to something more sophisticated

The pattern has a ceiling. If any of these show up, it's time to level up:

- **The "ambiguous" bucket grows over time.** The distribution is shifting; the deterministic scorer needs an update, or the thresholds need retuning.
- **The judge disagrees with itself across runs at temperature=0.** The prompt is probably too long or has internal contradictions. Compress and add examples.
- **You need to explain the judge's decision to a regulator.** Log the reason field and version the prompt — but also ask whether deterministic rules might be safer for that compliance domain.
- **You need 10K+ ambiguous decisions per minute.** Batch the LLM calls or precompute hashes and pre-warm the cache.

## Related

- The full evolution: [`docs/matcher-evolution.md`](matcher-evolution.md)
- The architectural decision: [`docs/decisions/001-llm-judge-over-rules.md`](decisions/001-llm-judge-over-rules.md)
- The multi-model gateway decision: [`docs/decisions/002-multi-model-gateway.md`](decisions/002-multi-model-gateway.md)
- The cache strategy: [`docs/decisions/004-cache-strategy.md`](decisions/004-cache-strategy.md)
