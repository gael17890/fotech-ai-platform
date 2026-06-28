# Multi-Agent Architecture

How 8 specialized agents, 4 tactical sub-agents, and an intent router work together to make a pharmacy chat with itself.

## The decision: not one big agent

When I started, the obvious move was to put everything behind a single Sonnet-4-flavored super-agent with a giant system prompt and a long list of tools. It works for a demo. It falls over in production.

Three problems killed the single-agent approach for me:

1. **The system prompt grew uncontrollably.** Every new feature meant new rules in the prompt. By the time I had inventory, sales, restock, and onboarding all in one prompt, the model was confusing rules across domains.
2. **Cost scaled the wrong way.** Every request paid the price of the full prompt, even for trivial intents.
3. **State machines don't compose in a single prompt.** Onboarding a product has clear states (`IDENTIFYING → ASKING_DATA → COLLECTING_LOTS → ... → DONE`). Sales doesn't. Mixing them as conversational rules made debugging a nightmare.

So I split the system into 8 specialized agents, each with its own focused prompt, its own state machine if needed, and its own tools. An **intent router** decides which one handles each request.

## The router

The router has two layers:

**Layer 1 — regex (free, 0 tokens, ~1ms):**

```js
// src/router/intent-router.js
const PATTERNS = [
  { agent: 'sale',     pattern: /\b(vendí|cobré|venta de|sold|charged)\b/i },
  { agent: 'search',   pattern: /\b(precio|cuánto|cuanto|busca|tienes|stock)\b/i },
  { agent: 'restock',  pattern: /\b(falta|faltó|me faltó|qué pedir|resurtido)\b/i },
  { agent: 'bulk_onboarding', pattern: /\b(factura|recibí|llegó pedido)\b/i },
  { agent: 'quote',    pattern: /\b(cotización|cuánto cuesta|necesito|cotizar)\b/i },
  // ...
];

function routeLayer1(message) {
  for (const { agent, pattern } of PATTERNS) {
    if (pattern.test(message)) return agent;
  }
  return null;  // L2 takes over
}
```

This handles ~80% of intents. It's free.

**Layer 2 — Haiku 4.5 classifier (only when L1 doesn't match):**

```js
async function routeLayer2(message, recentContext) {
  const r = await haiku.complete({
    system: ROUTER_PROMPT,           // ~200 tokens, agent descriptions only
    user: message,
    max_tokens: 20,                  // just the agent name
    temperature: 0,
  });
  return r.choices[0].message.content.trim().toLowerCase();
}
```

The router prompt only knows agent *names and one-line descriptions*. It doesn't know the domain. It's a cheap classifier, not a domain expert.

That separation is the point: **the router doesn't know pharmacy. The agents do.**

## The 8 agents

Each agent is a module with a `handle(message, context)` function, a system prompt, and a tool set.

| Agent | When it fires | What it does | Maturity |
|---|---|---|---|
| **Bulk Onboarding (AFF)** | New invoice arrives | Full pipeline: extract → match → investigate → fill 20+ fields per product | Most mature |
| **Solo Onboarding** | Admin scans a barcode | State machine to add a single product, ask only what's missing | Stable |
| **Search** | "do I have...", "stock of...", "price of..." | Natural-language query against catalog and inventory | Stable |
| **Sale** | "sold X of Y" | Logs sales, decrements stock, attaches lot/expiration | Stable |
| **Quote** | "need 5 boxes of X" | WhatsApp customer quote generation | Stable |
| **Restock** | "what ran out", "build me a purchase order" | Detects gaps, proposes orders by supplier | In calibration |
| **Purchase** | "who did I buy X from last", "price history" | Supplier and price intelligence | In calibration |
| **Admin** | "monthly report", "controlled substances list" | Reports, prescriptions, regulatory documents | In calibration |

Some have state machines (Bulk Onboarding, Solo Onboarding), some are stateless (Search, Sale). The router doesn't care — it just dispatches.

### Agents with state machines

The two onboarding agents have explicit, validated state machines. Here's Solo Onboarding's:

```
       ┌──────┐
       │ IDLE │
       └───┬──┘
           │ scan / type product
           ▼
  ┌──────────────────┐
  │   IDENTIFYING    │  ← match against catalog
  └────────┬─────────┘
           │ not found in catalog
           ▼
  ┌──────────────────┐
  │  ASKING_DATA     │  ← Haiku QUESTIONER asks only what's needed
  └────────┬─────────┘
           │ data complete
           ▼
  ┌──────────────────┐
  │  COLLECTING_LOTS │  ← lot, expiration, qty per batch
  └────────┬─────────┘
           │
           ▼
  ┌──────────────────┐
  │ BRAIN_COMPLETING │  ← Sonnet fills 20+ fields from partial info
  └────────┬─────────┘
           │
           ▼
  ┌──────────────────┐
  │     PREVIEW      │  ← human review before commit
  └────────┬─────────┘
           │ confirm
           ▼
  ┌──────────────────┐
  │     CREATING     │  ← writes to DB transactionally
  └────────┬─────────┘
           │
           ▼
  ┌────────────────────┐
  │ STOCK_DISTRIBUTION │  ← multi-branch allocation
  └────────┬───────────┘
           │
           ▼
       ┌──────┐
       │ DONE │
       └──────┘
```

Each transition is **validated** — the agent rejects messages that don't fit the current state. This is what keeps the conversation from going off the rails when the LLM gets confused.

### Bulk Onboarding (AFF) — the most mature

This is the agent the rest of the repo zooms in on. It handles an invoice end-to-end:

```
Invoice file/text
       │
       ▼
┌──────────────┐
│   EXTRACT    │  ← Kimi K2.6 (Fireworks), structured output
└──────┬───────┘
       │
       ▼
┌──────────────┐
│    MATCH     │  ← hybrid scorer + LLM judge (the matcher)
└──────┬───────┘
       │
       ├─→ existing → fill in lot, qty, cost
       ├─→ ambiguous → human review queue
       └─→ new
              │
              ▼
       ┌──────────────┐
       │ INVESTIGATE  │  ← Tavily web search + Haiku IDENTIFIER
       └──────┬───────┘
              │
              ▼
       ┌──────────────┐
       │     FILL     │  ← Sonnet fills 20+ fields with PHARMACIST + VALIDATOR
       └──────┬───────┘
              │
              ▼
       ┌──────────────┐
       │   PREVIEW    │  ← admin reviews batch
       └──────┬───────┘
              │
              ▼
            commit
```

The matcher is the centerpiece. See [`docs/matcher-evolution.md`](matcher-evolution.md) for the full story.

## The 4 Haiku tactical sub-agents

These aren't end-user-facing. They're **tools the larger agents delegate to** when they need a focused, cheap call.

### IDENTIFIER

When Bulk Onboarding hits a new product and the investigator returns web search results, IDENTIFIER's job is to extract a normalized record from raw HTML/text:

```
Input:  raw text from a pharmaceutical reference site
Output: {
  brand, active_ingredient, form, concentration, pack,
  manufacturer, sanitary_registration, image_url
}
```

Why a separate Haiku call instead of inline in Sonnet? Cost and latency. Sonnet's at ~$3 in / $15 out per MTok. Haiku is at $1 / $5. The IDENTIFIER call is ~600 input tokens, ~150 output. Sonnet would cost ~$0.004 per call. Haiku costs ~$0.001. At thousands of products per onboarding session, that adds up.

### QUESTIONER

When data is missing, QUESTIONER generates the **minimum set of questions** to ask the admin. Not "fill all 20 fields" — only the fields the system genuinely can't infer.

```
Input:  partial record + list of mandatory fields
Output: ordered list of conversational questions
```

The QUESTIONER prompt includes rules like *"don't ask for concentration if it's in the brand name"*, *"don't ask for form if the presentation already encodes it"*.

### PHARMACIST

A virtual pharmacist with a clinical-reasoning prompt. Used when the system needs domain judgment that's hard to encode as rules:

- "Is this product likely to require a prescription?"
- "Is this likely a controlled substance based on the active ingredient?"
- "Is this brand typically pediatric or adult?"

The PHARMACIST is consulted by the FILL stage of Bulk Onboarding to populate fields the system can't determine deterministically.

### VALIDATOR

The last gate before writing to the database. VALIDATOR receives a complete proposed record and answers a single question: *"is this internally consistent?"*

```
Input:  full proposed product record
Output: { valid: true/false, issues: ["reason 1", "reason 2"] }
```

Things VALIDATOR catches:
- Concentration unit doesn't match the form (`500MG/ML` makes no sense for tablets)
- Pack size doesn't match the form (`c/100` is suspicious for an injectable)
- Active ingredient and brand are mismatched (the brand is for a different drug)

If VALIDATOR returns `false`, the record goes back to QUESTIONER for clarification with the admin rather than committing a junk row.

## Why sub-agents, not just tool calls?

A tool call inside Sonnet is just a function with a JSON signature. A sub-agent is its own LLM call with its own prompt.

I use sub-agents when:
1. The call needs **its own system prompt** distinct from the parent agent.
2. The work is **substantial enough to need reasoning** beyond a deterministic function.
3. **Cost or model selection** matters — I want Haiku here, Sonnet there.

I use plain tool calls when:
1. The work is **deterministic** (database query, calculation).
2. **No prompt** is needed — just inputs and outputs.

The pattern: **sub-agents for judgment, tool calls for facts.**

## Cross-cutting services

All agents share these:

- **Memory** — conversational history, searchable via `tsvector`. ([`memory-and-learning.md`](memory-and-learning.md))
- **Aliases** — learned mappings from supplier-specific names to catalog products. ([`memory-and-learning.md`](memory-and-learning.md))
- **Cache** — persistent LLM decision cache. ([`docs/decisions/004-cache-strategy.md`](decisions/004-cache-strategy.md))
- **Audit** — `auditoria-multi-llm.js` compares decisions across models for drift detection.
- **RBAC/PDP** — every action passes through the Policy Decision Point. ([`rbac-architecture.md`](rbac-architecture.md))

## Dependency injection (the thing that makes this testable)

Agents don't import their tools directly. They receive them via constructor. This means I can swap real tools for stubs in tests without spending money.

```js
// src/agents/bulk-onboarding.js (sketch)
function createBulkOnboardingAgent({ extract, match, investigate, fill, validate, memory }) {
  return {
    async handle(invoice, context) {
      const extracted = await extract(invoice);
      const matched = await Promise.all(extracted.lines.map(l => match(l)));
      // ...
    }
  };
}

// In production:
const agent = createBulkOnboardingAgent({
  extract: realKimiExtractor,
  match: realMatcher,
  // ...
});

// In tests:
const agent = createBulkOnboardingAgent({
  extract: () => Promise.resolve({ lines: [...fixture] }),
  match: stubMatcher,
  // ...
});
```

No LLM call happens in unit tests. Integration tests use the real tools but on a 10-line fixture invoice, not the full 88.

## Honest limits

- **Only the Bulk Onboarding agent is fully production-mature.** The others have stable routing and prompts but are still being calibrated against real usage.
- **The router L2 fallback is not bulletproof.** It misclassifies ~5% of edge cases (regional Spanish slang, technical pharmacy jargon I haven't covered). The agent that gets a misrouted message politely hands it back.
- **State machines need maintenance.** Every new field in a product means revisiting the BRAIN_COMPLETING state. I lean on tests to catch regressions.

## Related

- [`docs/llm-judge-pattern.md`](llm-judge-pattern.md) — the LLM-as-judge pattern used inside the matcher
- [`docs/matcher-evolution.md`](matcher-evolution.md) — the deep dive on the matcher
- [`docs/memory-and-learning.md`](memory-and-learning.md) — memory and the alias-learning system
- [`docs/rbac-architecture.md`](rbac-architecture.md) — the security layer around the agents
