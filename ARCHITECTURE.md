# Architecture

A technical overview of how FOTECH is built. Not exhaustive — just enough to make the design choices legible.

## Mental model

Pharmacy work is a chat with the inventory. The admin says things like *"sold 200 of paracetamol"*, *"what ran out today"*, *"process this invoice from Distributor A"*. The platform turns each of those into the right action against the right data with the right safety checks.

The architecture is built around four ideas:

1. **A natural-language chat is the primary interface**, not forms. Forms are a fallback when the chat needs structured input.
2. **An intent router decides which specialized agent handles the request.** The platform is not one big agent — it's 8 specialized ones, each with its own prompts, state machine when needed, and tool set.
3. **The LLM is one tool among many, not the whole system.** A regex matches most intents in 0 tokens. Hand-rolled algorithms handle deterministic decisions. LLMs only enter when judgment is required.
4. **Memory and learning are first-class, not bolted on.** Every confirmation the admin makes becomes a training signal stored as data, not as model weights. The system gets smarter without retraining.

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
| Solo Onboarding | Add a single product (often from a barcode scan) | Stable |
| Search | Natural-language queries against inventory | Stable |
| Sale | Log sales by chat ("sold 200 of paracetamol") | Stable |
| Quote | Customer quotes from WhatsApp | Stable |
| Restock | Detect gaps, build purchase orders | In calibration |
| Purchase | Track supplier history, prices | In calibration |
| Admin | Reports, prescriptions, controlled substances | In calibration |

Each agent has its own system prompt, may have its own state machine, and shares the cross-cutting services (memory, aliases, cache, audit, RBAC).

The **4 Haiku tactical sub-agents** are delegations the larger agents make:
- **IDENTIFIER** — extracts pharmaceutical data from search results
- **QUESTIONER** — generates minimal follow-up questions for the admin
- **PHARMACIST** — acts as a virtual pharmacist for clinical reasoning
- **VALIDATOR** — checks logical coherence before committing to the database

Routing to Haiku reduces cost and latency vs. always calling Sonnet.

## Architectural decisions

These are the choices that shape everything else. Each one has an ADR (Architecture Decision Record) in [`docs/decisions/`](decisions/).

| Decision | Why | What it cost |
|---|---|---|
| **LLM-as-judge over hand-rolled rules** for matching | Rules don't generalize across clients with different catalogs. Each new client breaks 30% of the rules. | Need an eval suite and budget caps. ([ADR-001](decisions/001-llm-judge-over-rules.md)) |
| **Multi-model gateway with env-var swap** (Vercel AI Gateway) | A/B testing between Claude / Gemini / DeepSeek without refactor | Some rate limits on the free tier (learned the hard way). ([ADR-002](decisions/002-multi-model-gateway.md)) |
| **Lexical RAG with PostgreSQL `tsvector`** in Spanish | Pharmaceutical names are very specific — embeddings overkill; lexical is faster and free | Misses some semantic matches (acceptable trade-off). ([ADR-003](decisions/003-postgres-tsvector-rag.md)) |
| **Persistent LLM cache with model in the hash** | Dev iteration is most of the cost. Most decisions repeat. | Cache invalidation needs care when prompts change. ([ADR-004](decisions/004-cache-strategy.md)) |

## The stack

| Layer | What | Why |
|---|---|---|
| **Orchestrator** | Node.js + Claude Sonnet 4.6 (function calling) | Sonnet is good at routing + dependency-injection-style tool use |
| **Specialized agents** | Mix of Sonnet 4.6 (long-context) and Haiku 4.5 (cheap, fast tactical) | Pay for what you need |
| **Matcher judge** | Claude Haiku 4.5 via Vercel AI Gateway | $0.0019 / decision, swap-able via env var |
| **Invoice extractor** | Kimi K2.6 via Fireworks (Together.ai) | Strong on structured text extraction at low cost |
| **Web research** | Tavily (`search_depth: advanced`) | Pharmacist-grade sources only |
| **Voice agent** | Pipecat + Deepgram Nova-3 + Claude Sonnet + ElevenLabs Flash v2.5 | Real-time conversation; Mexican Spanish voice |
| **Memory** | PostgreSQL `tsvector` + `ts_rank` (Spanish dictionary) | No embedding bill, fast, multi-tenant by row |
| **Cache** | PostgreSQL with SHA-256 hash of `(tenant + factura + candidates + model)` | Per-model cache so model swaps don't poison results |
| **Identity** | Keycloak (SSO, 2FA, OAuth 2.0) + custom RBAC table integration | Standard IAM with custom permission graph |
| **Authorization** | Dedicated PDP (Policy Decision Point) container + Redis L1/L2 cache | Bank-grade RBAC + ABAC + ReBAC ([details](rbac-architecture.md)) |
| **Workflow store** | PostgreSQL with `ltree` for hierarchies | Multi-tenant region/branch nesting |

## Repo layout

```
fotech-ai-platform/
├── README.md                           Hero + verification table
├── ARCHITECTURE.md                     ← you are here
├── docs/
│   ├── matcher-evolution.md            27% → 70% → 10× lower ambiguity
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

## What's NOT here

- **No business logic specific to the ERP (Odoo extensions, custom modules).** Private.
- **No production prompts in full.** Structure documented; complete prompts kept private.
- **No infrastructure-as-code.** Diagrammed, not provided.
- **No real client data.** All fixtures anonymized. Suppliers are `Distributor A/B/C/D`.

If you're reviewing this for hiring, a [live demo or deeper code review](mailto:gael17890@gmail.com) is possible under NDA.

## Where to read next

- For **the most impressive technical story**: [`docs/matcher-evolution.md`](docs/matcher-evolution.md) — the matcher journey.
- For **the most reusable pattern**: [`docs/llm-judge-pattern.md`](docs/llm-judge-pattern.md).
- For **the dev environment that makes this possible solo**: [`docs/augmented-engineering.md`](docs/augmented-engineering.md).
