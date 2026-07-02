# Architecture

A technical overview of how FOTECH is built. Not exhaustive — just enough to make the design choices legible.

## Mental model

Pharmacy work looks a lot like a chat with the inventory. The admin says things like *"sold 200 of paracetamol"*, *"what ran out today"*, *"process this invoice from Distributor A"*. The platform's job is to turn each of those into the right action against the right data with the right safety checks.

Four ideas shape the architecture:

1. **The chat is the primary interface, not forms.** Forms show up as a fallback when the chat genuinely needs structured input.
2. **An intent router picks the specialized agent.** There isn't one giant agent — there are 8 specialized ones, each with its own prompts, its own state machine when it needs one, and its own tools.
3. **The LLM is one tool among many, not the whole system.** A regex handles most intents in 0 tokens. Deterministic algorithms handle the decisions that don't need judgment. LLMs only step in where judgment is required.
4. **Memory and learning are first-class, not bolted on.** Every confirmation the admin makes becomes a training signal — but stored as data, not baked into model weights. The system gets sharper without a retraining pipeline.

## The agents

```
┌────────────────────────────────────────────────────────────────┐
│                          ADMIN                                 │
│                  (chat, voice, mobile)                         │
└────────────────────────────┬───────────────────────────────────┘
                             │
                  ┌──────────▼──────────┐
                  │   Intent Router     │
                  │ regex L1 (0 tokens) │
                  │   + LLM fallback    │
                  └──────────┬──────────┘
                             │
   ┌──────────┬──────────┬───┴────┬──────────┬──────────┐
   ▼          ▼          ▼        ▼          ▼          ▼
 Bulk      Solo      Search     Sale      Quote     Restock
Onbrd.    Onbrd.       │          │         │          │
(AFF)     │            │          │         │          │
   │      │            │          │         │          │
   ▼      ▼            ▼          ▼         ▼          ▼
   Sub-agents (Haiku tactical):
   IDENTIFIER ─ QUESTIONER ─ PHARMACIST ─ VALIDATOR

   Cross-cutting services:
   Memory ─ Aliases ─ Cache ─ Audit ─ RBAC/PDP
```

| Agent | Job | Maturity |
|---|---|---|
| Bulk Onboarding (AFF) | Process a supplier invoice end-to-end | **Most mature — this repo's deep dive** |
| Solo Onboarding | Add a single product (usually from a barcode scan) | Stable |
| Search | Natural-language queries against inventory | Stable |
| Sale | Log sales by chat ("sold 200 of paracetamol") | Stable |
| Quote | Customer quotes from WhatsApp | Stable |
| Restock | Detect gaps, build purchase orders | In calibration |
| Purchase | Track supplier history and prices | In calibration |
| Admin | Reports, prescriptions, controlled substances | In calibration |

Each agent owns its system prompt, may own a state machine, and shares the cross-cutting services (memory, aliases, cache, audit, RBAC).

The **4 Haiku tactical sub-agents** are delegations the larger agents make when they need a focused, cheap call:
- **IDENTIFIER** pulls pharmaceutical data out of search results
- **QUESTIONER** generates the minimum set of follow-up questions for the admin
- **PHARMACIST** does clinical reasoning as a virtual pharmacist
- **VALIDATOR** checks logical coherence before anything gets committed

Routing this work to Haiku keeps cost and latency down without giving up quality on the tactical calls.

## Architectural decisions

These are the calls that shape everything downstream. Each one has an ADR in [`docs/decisions/`](decisions/).

| Decision | Why | What it cost |
|---|---|---|
| **LLM-as-judge over hand-rolled rules** for matching | Rules stop generalizing the moment you sign a new client. Each new catalog breaks ~30% of the rules. | Needed an eval suite and budget caps. ([ADR-001](decisions/001-llm-judge-over-rules.md)) |
| **Multi-model gateway with env-var swap** (Vercel AI Gateway) | A/B testing Claude / Gemini / DeepSeek without refactoring | Some free-tier rate limits, learned the hard way. ([ADR-002](decisions/002-multi-model-gateway.md)) |
| **Lexical RAG with PostgreSQL `tsvector`** in Spanish | Pharmaceutical names are token-specific; embeddings would be overkill. Lexical is faster and free. | Misses some semantic matches — acceptable trade-off. ([ADR-003](decisions/003-postgres-tsvector-rag.md)) |
| **Persistent LLM cache with model in the hash** | Dev iteration is where most of the cost lives. Most decisions repeat. | Cache invalidation needs care when prompts change. ([ADR-004](decisions/004-cache-strategy.md)) |

## The stack

| Layer | What | Why |
|---|---|---|
| **Orchestrator** | Node.js + Claude Sonnet 4.6 (function calling) | Sonnet handles routing and DI-style tool use cleanly |
| **Specialized agents** | Mix of Sonnet 4.6 (long-context) and Haiku 4.5 (cheap, fast tactical) | Pay for what each job actually needs |
| **Matcher judge** | Claude Haiku 4.5 via Vercel AI Gateway | $0.0019 a decision, swap-able via env var |
| **Invoice extractor** | Kimi K2.6 via Fireworks (Together.ai) | Strong on structured text extraction at low cost |
| **Web research** | Tavily (`search_depth: advanced`) | Pharmacist-grade sources only |
| **Voice agent** | Pipecat + Deepgram Nova-3 + Claude Sonnet + ElevenLabs Flash v2.5 | Real-time conversation in Mexican Spanish |
| **Memory** | PostgreSQL `tsvector` + `ts_rank` (Spanish dictionary) | No embedding bill, fast, multi-tenant by row |
| **Cache** | PostgreSQL with SHA-256 hash of `(tenant + factura + candidates + model)` | Per-model cache so model swaps don't poison results |
| **Identity** | Keycloak (SSO, 2FA, OAuth 2.0) + custom RBAC table integration | Standard IAM with a custom permission graph on top |
| **Authorization** | Dedicated PDP (Policy Decision Point) container + Redis L1/L2 cache | Bank-grade RBAC + ABAC + ReBAC ([details](rbac-architecture.md)) |
| **Workflow store** | PostgreSQL with `ltree` for hierarchies | Multi-tenant region/branch nesting |

## Repo layout

```
fotech-ai-platform/
├── README.md                           Hero + verification table
├── ARCHITECTURE.md                     ← you are here
├── docs/
│   ├── matcher-evolution.md            27% → 70% → 10× less ambiguity
│   ├── llm-judge-pattern.md            The pattern, when it applies
│   ├── multi-agent-architecture.md     Routing, agents, sub-agents
│   ├── memory-and-learning.md          tsvector + continuous learning
│   ├── augmented-engineering.md        Claude Code + Gemini CLI + 2 MCPs
│   ├── rbac-architecture.md            391 / 76 / 4,093 / 30
│   ├── production-infrastructure.md    The 8 containers
│   └── decisions/                      ADRs
├── src/                                Sanitized real code
├── evals/                              Reproducible eval suite
├── tests/                              Unit tests
├── diagrams/                           Exported SVG/PNG
└── .github/workflows/                  CI
```

## What's not here

- No business logic specific to the ERP (Odoo extensions, custom modules). That stays private.
- No production prompts in full. You get the structure; the wording is out.
- No infrastructure-as-code. Diagrammed only.
- No real client data. Every fixture is anonymized. Suppliers are `Distributor A/B/C/D`.

If you're reviewing this for hiring, a [live demo or deeper code review](mailto:gael17890@gmail.com) is on the table under NDA.

## Where to read next

- For **the most impressive technical story**, [`docs/matcher-evolution.md`](docs/matcher-evolution.md) — the matcher journey.
- For **the most reusable pattern**, [`docs/llm-judge-pattern.md`](docs/llm-judge-pattern.md).
- For **the dev environment that makes this possible solo**, [`docs/augmented-engineering.md`](docs/augmented-engineering.md).
