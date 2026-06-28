# ADR-001: LLM-as-judge over hand-rolled rules for product matching

**Status**: Accepted
**Date**: 2026-06
**Deciders**: Gael (sole developer)

## Context

The product matcher (described in [`docs/matcher-evolution.md`](../matcher-evolution.md)) had been built with hand-rolled rules. By v2, it achieved 70.4% match rate / 11.5% ambiguous on the eval suite of 88 invoices. To go further, two options were on the table:

1. **More rules.** Identify the ~280 ambiguous lines, look for patterns, add more synonyms / filters / heuristics.
2. **LLM-as-judge.** Run the literal scorer to get the top 3 candidates, then call an LLM to decide among them.

The forcing function was: **rules don't generalize across clients**. Each new pharmacy or distributor has different supplier conventions. A rule that fixed Distributor A would break Distributor B. We were already seeing this in the field with the FIX 3 incident — see [`docs/matcher-evolution.md#the-thing-that-didnt-work-fix-3`](../matcher-evolution.md).

## Decision

Adopt the LLM-as-judge pattern as the path forward for ambiguous cases. Keep the literal scorer for the clearly-easy cases (top1 ≥ 0.95 → match, top1 < 0.15 → new). Only call the LLM in the middle.

The judge is a single Claude Haiku 4.5 call with:
- Strict JSON output (`{ elegido, confianza, razon }`)
- A 650-token system prompt encoding pharmaceutical equivalence rules
- 4 worked examples
- Temperature = 0

Cache the result in PostgreSQL keyed by `(tenant + invoice + candidates + model)`.

## Alternatives considered

### A. More rules (rejected)

- Pros: zero LLM cost; deterministic; auditable.
- Cons: doesn't scale across clients; whack-a-mole maintenance; FIX 3 incident already demonstrated the failure mode.

### B. Fine-tune a small classifier on the existing data (rejected)

- Pros: very fast inference; potentially cheaper than LLM calls.
- Cons:
  - Training data is small (~543 confirmed labels) — overfitting risk high.
  - Re-training cycle is slow (hours) vs. prompt iteration (minutes).
  - Per-tenant fine-tuning is operationally complex.
  - Doesn't help with the rule-generalization problem; only with the speed of decisions, which isn't the bottleneck.

### C. Embedding similarity (rejected)

- Pros: handles semantic similarity better than n-grams.
- Cons: pharmaceutical product names are token-specific, not "semantically similar" — embeddings don't add useful signal. Adds inference cost and dependency on an embedding provider for no measurable gain on the eval suite.

### D. LLM-as-classifier (instead of judge) (rejected)

- Pros: simpler API contract; LLM does everything.
- Cons: pays LLM cost on every line, including the obvious ones; ~5× higher LLM bill for no quality improvement on the clear cases.

## Consequences

### Positive

- Ambiguity rate dropped from 11.5% to 1.1% on the validated subset.
- Pattern is reusable for future clients without per-client rule-writing.
- The judge prompt is one place to update when domain rules change, instead of N places in the rule code.
- The 4,093 LLM decisions in the cache form a free dataset for future fine-tuning if we want to revisit later.

### Negative

- Adds LLM as an external dependency for matching — needs cache, budget caps, kill switches, fallback to v2 on outages.
- A bad prompt can degrade quality silently. Mitigation: eval suite catches regressions.
- LLM judgment for medical-product matching has regulatory implications — *who is responsible if the judge makes a wrong call?*. Mitigation: the judge is one input among several (literal score, human review, alias-learning over time). Zero-tolerance false positives remain the v2 hard filters.

### Neutral

- Costs ~$0.0019 per ambiguous decision. At pilot client volume, this is negligible.
- Latency ~1.5s p50 per ambiguous decision. Tolerable for the use case (bulk onboarding is async).

## Follow-ups

- Run the full 88-invoice baseline once Vercel rate-limit issues are resolved (currently partial run of 543 lines). See DEUDA-AFF-V3-001 in internal logs.
- Build the alias-learning system to recover the LLM-resolved decisions as cheap database hits over time. ([`docs/memory-and-learning.md`](../memory-and-learning.md))
- Document the prompt versioning strategy (currently informal).
