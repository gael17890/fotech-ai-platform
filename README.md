# FOTECH AI Platform

> Multi-agent AI platform for pharmaceutical inventory management. Sole founder, real pilot client, real production patterns.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Node](https://img.shields.io/badge/node-%E2%89%A518.0.0-green.svg)](https://nodejs.org/)
[![Architecture](https://img.shields.io/badge/architecture-multi--agent-blueviolet.svg)](docs/multi-agent-architecture.md)
[![Pattern](https://img.shields.io/badge/pattern-LLM--as--judge-orange.svg)](docs/llm-judge-pattern.md)

---

## What this is

A **public, sanitized showcase** of the architecture and patterns behind FOTECH — a multi-agent AI platform I built (alone) for pharmaceutical distributors and pharmacies in Mexico. The full production system is private (real client data, business logic, regulatory configurations). What lives here is **the reusable engineering**: the patterns, the architectural decisions, the eval methodology, the code that solves the hard problems.

This repo exists so that someone reviewing my work can see *how I think* and *how I build*, not just read claims on a résumé.

## The problem in 30 seconds

Mexican pharmacies and distributors receive invoices from dozens of suppliers, each with their own naming conventions for the same drug. A single product like *paracetamol 500mg c/10* might appear as `DOLXEN 500MG C/10 TABLETAS`, `DOLXEN 500MG Tabletas c/10`, `dolxen tab. 500mg cja/10`, or any number of variations. Manually mapping these to a catalog is slow, error-prone, and doesn't scale. Existing solutions either over-match (false positives that corrupt inventory) or over-flag (admins drown in ambiguity queues).

The platform solves this — and a dozen other pharmacy workflows — through a **multi-agent system** where natural language ("I sold 200 of paracetamol", "what ran out today", "process this supplier's invoice") gets routed to a specialized agent that handles the task end to end.

## Architecture at a glance

```
                      ┌─────────────────────┐
                      │  Pharmacy admin     │
                      │  (chat, natural)    │
                      └──────────┬──────────┘
                                 │
                      ┌──────────▼──────────┐
                      │   Intent router     │  regex Layer 1 (0 tokens)
                      │   (8 specialized    │  + LLM fallback
                      │    agents below)    │
                      └──────────┬──────────┘
                                 │
   ┌──────────┬──────────┬───────┼───────┬──────────┬──────────┬──────────┐
   ▼          ▼          ▼       ▼       ▼          ▼          ▼          ▼
┌──────┐ ┌────────┐ ┌────────┐ ┌────┐ ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐
│ Bulk │ │  Solo  │ │ Search │ │Sale│ │ Quote  │ │Restock │ │Purchase│ │ Admin  │
│Onbrd.│ │ Onbrd. │ │        │ │    │ │        │ │        │ │        │ │        │
│(AFF) │ │        │ │        │ │    │ │        │ │        │ │        │ │        │
└──┬───┘ └────────┘ └────────┘ └────┘ └────────┘ └────────┘ └────────┘ └────────┘
   │
   │  (most-developed agent, the showcase deep-dive)
   ▼
┌────────────────────────────────────────────────────────────────────┐
│  Bulk Onboarding (AFF) pipeline                                    │
│                                                                    │
│   ┌──────────┐   ┌──────────┐   ┌──────────┐   ┌──────────┐        │
│   │ Extract  │ → │  Match   │ → │Investigate│ → │   Fill   │        │
│   │ (Kimi)   │   │(hybrid)  │   │(Haiku+web)│   │  (LLM)   │        │
│   └──────────┘   └────┬─────┘   └──────────┘   └──────────┘        │
│                       │                                            │
│              ┌────────▼────────┐                                   │
│              │  LLM-as-judge   │   Haiku 4.5                       │
│              │  for ambiguous  │   (1.1% of lines, was 11.5%)      │
│              └─────────────────┘                                   │
│                                                                    │
│  Sub-agents (Haiku tactical):                                      │
│  IDENTIFIER · QUESTIONER · PHARMACIST · VALIDATOR                  │
└────────────────────────────────────────────────────────────────────┘
```

## What's in this repo

| Area | What you'll find |
|---|---|
| [`docs/matcher-evolution.md`](docs/matcher-evolution.md) | How the product matcher went from 27% accuracy with hand-rolled rules to **10× lower ambiguity** with hybrid algorithm + LLM-as-judge. The full evolution story with real numbers. |
| [`docs/llm-judge-pattern.md`](docs/llm-judge-pattern.md) | The LLM-as-judge pattern: when to use it, when *not* to, and how to ship it cheaply (~$0.0019 per decision). |
| [`docs/multi-agent-architecture.md`](docs/multi-agent-architecture.md) | The 8 specialized agents, the intent router, the 4 Haiku tactical sub-agents. |
| [`docs/memory-and-learning.md`](docs/memory-and-learning.md) | Lexical RAG with PostgreSQL `tsvector` (Spanish). Continuous learning without retraining. |
| [`docs/augmented-engineering.md`](docs/augmented-engineering.md) | My dev environment: Claude Code + Gemini CLI orchestrated through custom MCP connectors and async messaging. 5-10× faster development. |
| [`docs/rbac-architecture.md`](docs/rbac-architecture.md) | Bank-grade RBAC + ABAC + ReBAC in Postgres: 391 atomic permissions, 76 roles, 4,093 role-permission entries, 30 SoD rules. |
| [`docs/production-infrastructure.md`](docs/production-infrastructure.md) | The 8 production containers including dedicated PDP (Policy Decision Point), Keycloak IAM, and Voice Agent v1. |
| [`docs/decisions/`](docs/decisions/) | Architecture Decision Records (ADRs) — why each major choice was made and what was rejected. |
| [`src/matcher/`](src/matcher/) | The matcher code (sanitized): score-literal, LLM judge, hybrid orchestrator. |
| [`src/memory/`](src/memory/) | The lexical RAG and alias-learning code (sanitized). |
| [`src/cache/`](src/cache/) | LLM inference cache pattern with SHA-256 hashing and kill-switches. |
| [`src/router/`](src/router/) | Intent router (regex Layer 1 + LLM fallback). |
| [`evals/`](evals/) | Reproducible evaluation suite with anonymized fixtures and the runner that produces real `summary.json` outputs. |

## Key results (with evidence)

| Claim | Where to verify in this repo |
|---|---|
| Hybrid algorithm + LLM judge reduces ambiguity **10×** (11.5% → 1.1%) | [`docs/matcher-evolution.md`](docs/matcher-evolution.md) + [`evals/runs/`](evals/runs/) |
| LLM inference cache cuts cost ~80% | [`src/cache/llm-cache.js`](src/cache/llm-cache.js) + [`docs/decisions/004-cache-strategy.md`](docs/decisions/004-cache-strategy.md) |
| ~$0.0019 USD per LLM decision (Claude Haiku 4.5) | [`src/matcher/juez-llm.js`](src/matcher/juez-llm.js) — pricing table & cost tracking |
| Continuous learning without model retraining | [`src/memory/alias-learning.js`](src/memory/alias-learning.js) + schema |
| 391 atomic permissions, 76 roles, 4,093 entries, 30 SoD rules | [`docs/rbac-architecture.md`](docs/rbac-architecture.md) + sample schemas |

## What's NOT here (and why)

This is a showcase, not the production system:

- **No real client data.** Fixtures are anonymized; supplier names are generic (Distributor A/B/C/D).
- **No regulatory configurations for Mexico (COFEPRIS) in detail.** Mentioned in docs, not weaponized.
- **No business logic specific to the ERP backend.** The Odoo integration is private.
- **No production prompts in full.** Prompt structure shown, full prompts redacted.
- **No deployment scripts, secrets, infrastructure-as-code.** Diagrammed, not provided.

If you're a recruiter or hiring manager and want a live demo or deeper code review, [reach out](mailto:gael17890@gmail.com).

## Tech stack

**AI/LLM**: Claude (Haiku 4.5, Sonnet 4.6), Gemini (2.5 Flash, Pro), Kimi K2.6, DeepSeek V3, Vercel AI Gateway, Anthropic SDK, Tavily (web search)
**Backend**: Node.js, Python, PostgreSQL (`pgvector`, `ltree`, `tsvector`)
**Frontend**: React (Vite), Vue.js
**Infra**: Docker, Oracle Cloud Infrastructure (ARM), Contabo VPS, Keycloak IAM, nginx
**Dev tooling**: Claude Code + Gemini CLI orchestrated via custom MCP connectors

## About the author

[Gael Alberto Franco Ortiz](https://linkedin.com/in/gael-alberto-franco-ortiz-165a6a418) — Sole Founder and AI Engineer building enterprise SaaS for Mexican pharma. CS50 (Harvard) certified. Available 100% remote for AI Engineer roles, especially in healthcare. Reach out: gael17890@gmail.com.

---

*This repo is a public showcase. The full FOTECH platform is a private commercial product.*
