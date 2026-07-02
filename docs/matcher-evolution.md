# Matcher evolution

The story of how the product matcher went from **27% accuracy** with hand-rolled rules to **10× less ambiguity** with a hybrid algorithm + LLM-as-judge. Written honestly, including the things that didn't work.

This is the technical centerpiece of the platform. Almost every other agent leans on the matcher because it answers the deepest question in pharmacy data: *"is this thing on the invoice the same as that thing in my catalog?"*

## The problem

Mexican pharmacies and distributors receive invoices from dozens of suppliers, and **no two suppliers name the same drug the same way**. Some real examples, anonymized:

```
Invoice line                              Catalog name (truth)
─────────────────────────────────────     ──────────────────────────────────
DOLXEN 500MG Tabletas c/10                DOLXEN 500MG C/10 TABLETAS
BRUNADOL Suspension 100 ml                BRUNADOL SUSP NUEVO
METOCLOPRAMIDA (Neolpharma) Sol Iny c/6   METOCLOPRAMIDA  10MG. SOL. INY. C/6
AGUA OXIGENADA DERMOCLEEN 100ML           AGUA OXIGENADA PROTEC 100 ML   ← NOT a match
VOMISIN 50MG 20TABS                       VOMISIN 50MG C/20 TABLETAS
```

A naive string matcher gets some of these right. A real one has to know:

- **Presentation equivalences**: `TAB = TABS = TABLETA = TABLETAS = COMP = COMPRIMIDOS`
- **Differentiators**: `DOLO-NEUROBION 1 ≠ DOLO-NEUROBION FORTE`, even though they share most tokens
- **Route differences**: `SOL OFT (ophthalmic) ≠ SOL ORAL`, even with the same name
- **Brand vs ingredient**: `BENEVENTOL (CEFIXIMA)` — `CEFIXIMA` is the ingredient, `BENEVENTOL` is the brand
- **Concentration**: `500MG ≠ 250MG`
- **Pack size**: `c/10 ≠ c/20`

Getting this wrong fails in two directions, both bad:

1. **False positive**: `AGUA OXIGENADA DERMOCLEEN 100ML` matches `AGUA OXIGENADA PROTEC 100 ML` because of token overlap. Now `DERMOCLEEN` inventory gets booked as `PROTEC` and the catalog silently corrupts.
2. **Over-flagging**: every line goes to a human for review. The point of automation is gone.

The bar is **low false-positive rate AND low ambiguity rate**.

## Baseline: hand-rolled rules (v1)

The first version was a trigram similarity score with a thousand small patches layered on top.

```
27.4% E / 61.2% N / 11.4% A
```

`E` = existing product matched, `N` = new product detected, `A` = ambiguous (needs human review).

That **27% match rate is bad**, but the real problem was *how* it failed: a bug in `BRAND_BOOST` was silently downgrading most matches to "new", so the catalog was collecting duplicate products. I caught it in production at the pilot client.

That's when it clicked: **adding more rules wasn't going to work**. Each client had different supplier conventions; every rule that helped Distributor A broke something for Distributor B. Classic whack-a-mole.

## v2: four conceptual fixes (the "4 pieces")

I stopped tacking on random rules and consolidated everything into four orthogonal pieces.

### Piece 1 — Presentation synonyms

A normalized vocabulary (~60 entries) so the matcher treats `TAB`, `TABS`, `TABLETA`, `TABLETAS`, `COMP`, `COMPRIMIDO`, `COMPRIMIDOS` as the same token. Same for `SUSP/SUSPENSION`, `INY/INYECTABLE`, `GTS/GOTAS`, and so on.

```js
// from src/matcher/score-literal.js
const PRESENTATION_SYNONYMS = {
  TAB: ['TABS', 'TABLETA', 'TABLETAS', 'COMP', 'COMPRIMIDO', 'COMPRIMIDOS'],
  CAP: ['CAPS', 'CAPSULA', 'CAPSULAS'],
  SUSP: ['SUSPENSION'],
  SOL: ['SOLUCION'],
  INY: ['INYECTABLE', 'INYECT'],
  // ... ~60 entries
};

function normalizePresentation(text) {
  // word-boundary replace so 'TABLETAS' becomes 'TAB' but 'ATABLE' stays put
  // Watch out: \b in a JS string literal is backspace, not regex word-boundary.
  // Use '\\b' in the source.
  let out = text;
  for (const [canonical, variants] of Object.entries(PRESENTATION_SYNONYMS)) {
    for (const v of variants) {
      out = out.replace(new RegExp('\\b' + v + '\\b', 'gi'), canonical);
    }
  }
  return out;
}
```

**A bug I hit, kept here as a warning**: the `\b` word boundary has to be written as `'\\b'` in the source string, because `'\b'` is the backspace character (ASCII 0x08). I shipped it once with `'\b'` and spent an hour wondering why nothing matched.

### Piece 2 — Hard filters on form, pack, and concentration

If both sides state a property (form, pack, concentration), they have to agree. If one side is silent, the candidate stays in the running.

```js
// pseudocode — see src/matcher/score-literal.js
function passesHardFilters(invoiceLine, candidate) {
  const inv = extractProps(invoiceLine);
  const cand = extractProps(candidate);

  // both have form → must match
  if (inv.form && cand.form && inv.form !== cand.form) return false;
  // both have pack → must match
  if (inv.pack && cand.pack && inv.pack !== cand.pack) return false;
  // both have concentration → must match
  if (inv.concentration && cand.concentration && inv.concentration !== cand.concentration) return false;

  return true;
}
```

The key point: **silence ≠ disagreement**. Plenty of invoice lines don't include a pack size, and that's not a reason to throw out a candidate that has one.

### Piece 3 — Brand extraction and normalization

Earlier scoring compared the whole candidate string against the whole invoice line, which let the active ingredient (often in parentheses) contaminate the brand score. v2 extracts the brand from each side first and compares those.

```js
function extractBrand(text) {
  // remove parenthetical (usually active ingredient or lab)
  let cleaned = text.replace(/\(.*?\)/g, '').trim();
  // strip common presentation tokens we don't want in the brand
  cleaned = cleaned.replace(/\b(TAB|CAP|SUSP|SOL|INY|...)\b.*$/i, '').trim();
  // filter tokens shorter than 3 chars (drops 'C' from 'c/10', 'DE' suffix, etc.)
  return cleaned.split(/\s+/).filter(t => t.length >= 3).join(' ');
}
```

That `t.length >= 3` filter looks silly until you spend hours debugging why `DOLFORT-DE` doesn't match `DOLFORT-D`. Answer: `DE` was getting treated as a meaningful brand token.

### Piece 4 — Form groups for soft fallback

If hard filters kill every candidate but exactly one survivor sits in the same broad form group (`solid oral`, `liquid oral`, `injectable`, etc.), we relax the form constraint and let it through.

```js
const FORM_GROUPS = {
  solid_oral: ['TAB', 'CAP', 'COMP', 'GRAG'],
  liquid_oral: ['SUSP', 'SOL', 'JBE', 'GTS'],
  injectable: ['INY', 'AMP'],
  semisolid: ['CMA', 'UNG', 'GEL'],
  inhaled: ['AER', 'SPRAY'],
};
```

**Result of v2 over 2,419 invoice lines from 88 real invoices:**

```
70.4% E / 18.1% N / 11.5% A
```

That's a 43-point jump in match rate with 0% false positives in production.

## The thing that didn't work: FIX 3

I tried a fifth piece that looked obvious: **if the parenthetical contains a token that's not in our catalog, mark the whole line as new**. The reasoning was: `(Neolpharma)` is a lab we don't carry → must be a new product.

Great on the test data. Broke 21 lines on a real supplier's invoice. Reason: the parenthetical often contains the **active ingredient**, not the lab. `BENEVENTOL (CEFIXIMA)` is *brand BENEVENTOL, active ingredient CEFIXIMA*, and `CEFIXIMA` not being in our catalog is irrelevant.

I rolled the fix back and added a note to never bring it back without a way to distinguish lab from ingredient inside the parens.

**Lesson**: rules that look orthogonal usually aren't. The trigger condition (`unknown token in parens`) was a proxy for what I actually wanted (`unknown lab`), and the proxy leaked.

## v3: hybrid algorithm + LLM-as-judge

More rules wasn't going to work for new clients with new supplier conventions. The move was to separate two things:

- **Identity** (is this fundamentally the same drug?) → deterministic algorithm
- **Presentation** (is the form/pack/concentration the same?) → LLM judge when it's ambiguous

The matcher scores literally first (n-gram Jaccard). If the top candidate is clearly better than the second, take it. If the top candidate is far below everything, mark as new. Otherwise hand the top 3 to a Haiku 4.5 judge with a 650-token system prompt that encodes pharmaceutical equivalence rules and asks for a structured JSON verdict.

```js
// src/matcher/matcher-v3-llm.js (sanitized)
const THRESHOLDS = {
  CLEAR_MATCH: 0.95,      // top1 ≥ this → match directly
  CLEAR_MARGIN: 0.20,     // top1 ≥ 0.80 AND beats #2 by this → match
  NEW: 0.15,              // top1 < this → new product
  // anything in between → LLM judge with top-3
};

async function decideLineage({ invoiceLine, candidates, tenantId }) {
  const ranked = scoreLiteralAll(invoiceLine, candidates);
  const top1 = ranked[0];
  const margin = ranked[0].score - (ranked[1]?.score ?? 0);

  if (top1.score >= THRESHOLDS.CLEAR_MATCH) {
    return { decision: 'match', match: top1, via: 'score_direct_top1' };
  }
  if (top1.score >= 0.80 && margin >= THRESHOLDS.CLEAR_MARGIN) {
    return { decision: 'match', match: top1, via: 'score_direct_margin' };
  }
  if (top1.score < THRESHOLDS.NEW) {
    return { decision: 'new', via: 'score_new' };
  }

  // ambiguous — call judge with top 3
  const judgement = await judge.consult({
    invoice: invoiceLine,
    candidates: ranked.slice(0, 3),
    tenantId,
  });
  return interpretJudgement(judgement, ranked);
}
```

The judge prompt is the centerpiece (see [`src/matcher/juez-llm.js`](../src/matcher/juez-llm.js) for the full pattern). It encodes:

- Presentation equivalences (`TAB ≈ CAP only if everything else matches exactly`)
- Differentiator words (`FORTE`, `PLUS`, `NF`, `PEDIATRICO`)
- Route differences (oral ≠ ophthalmic ≠ otic)
- Population differences (don't match pediatric to non-pediatric)
- 4 worked examples (few-shot)

The output is structured JSON: `{ elegido, confianza, razon }`.

## v3 results — the honest version

I ran v3 against the same 88 invoices, 2,524 lines. Vercel AI Gateway's free tier rate-limited the run at line ~543, so the full baseline isn't done. But the partial results are still revealing.

**Over the 543 lines that processed cleanly:**

```
49.7% E / 49.2% N / 1.1% A
```

The numbers worth looking at:

- **Ambiguity dropped from 11.5% (v2) to 1.1% (v3)** — a 10× reduction.
- The LLM judge resolved most of the cases v2 sent to the ambiguous bucket.
- **Zero false positives** were observed in the resolved cases (I checked the first 50 by hand).

The lower match rate (49.7% vs 70.4%) is partly because v3 is more conservative about calling "match" when the LLM is uncertain — it prefers "new" over a low-confidence match. For inventory integrity, that's the right trade-off.

**Caveats I'm not going to hide**:

- The baseline isn't complete. The numbers above are on a 21.5% sample. The pattern is consistent across that sample, but the remaining 79% isn't validated against ground truth.
- v2 and v3 agree on 39.2% of decisions on the validated subset. Without manual ground truth on every line, I can't say v3 is *correct* more often — only that it's *more decisive*. Reducing ambiguity is the goal, but it has to be in the right direction.
- The 1.1% ambiguity rate needs to be confirmed at the full 88-invoice scale.

The plan to close this is in [DEUDA-AFF-V3-001](../../docs/decisions/001-llm-judge-over-rules.md) (Spanish original, since it's an internal debt log): swap the judge endpoint from Vercel to direct Anthropic when the budget allows, re-run with the existing 851-decision cache so the rate-limit issue doesn't repeat.

## What I'd do differently

- **Build the eval suite before the matcher, not after.** I retrofitted ground truth onto 84 invoices by hand. It took longer than writing the matcher itself.
- **Treat ambiguity rate as the primary metric, not match rate.** Match rate is gameable (you can match more aggressively at the cost of false positives). Ambiguity rate with false positives held at zero is the harder metric.
- **Cache from day one, not added later.** Re-runs during development cost real money until the persistent cache was in place.

## Reusable in other domains

The pattern (deterministic identity score + LLM judge for ambiguity) isn't pharmacy-specific. Same shape would work for:

- Vendor catalog reconciliation
- ICD-10 medical code lookup from clinical notes
- Product matching for marketplaces
- Legal citation disambiguation
- Anywhere the question is *"is X in our database the same thing as Y from outside?"* and the names don't quite line up.

The pattern is written up in [`docs/llm-judge-pattern.md`](llm-judge-pattern.md).

## Code

- [`src/matcher/score-literal.js`](../src/matcher/score-literal.js) — pure n-gram Jaccard
- [`src/matcher/juez-llm.js`](../src/matcher/juez-llm.js) — the LLM judge with cache and budget caps
- [`src/matcher/matcher-v3-llm.js`](../src/matcher/matcher-v3-llm.js) — the orchestrator
- [`evals/runner.js`](../evals/runner.js) — reproducible eval over the fixtures
- [`evals/fixtures/`](../evals/fixtures/) — 10 anonymized invoice samples
- [`evals/runs/`](../evals/runs/) — real `summary.json` outputs

The fixtures are 10 anonymized invoices, not the full 88, but the runner is the real runner. You can point it at your own LLM API key and rerun.
