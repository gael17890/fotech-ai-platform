# FOTECH AI Platform

> Multi-agent AI platform for pharmaceutical inventory management. Built solo. Piloted against a real pharmacy's catalog.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Node](https://img.shields.io/badge/node-%E2%89%A518.0.0-green.svg)](https://nodejs.org/)
[![Architecture](https://img.shields.io/badge/architecture-multi--agent-blueviolet.svg)](docs/multi-agent-architecture.md)
[![Pattern](https://img.shields.io/badge/pattern-LLM--as--judge-orange.svg)](docs/llm-judge-pattern.md)

---

## About this repo

This is a sanitized, public slice of FOTECH — a multi-agent AI platform I've been building alone for pharmacies and pharmaceutical distributors in Mexico. The production system is closed source (real client data, live regulatory config, business logic). What I've pulled out and cleaned up for this repo is the engineering that generalizes: the patterns, the decisions I had to make and why, the eval methodology, the pieces of code that took the most thought.

I put it together so anyone looking at my work can go past the résumé bullets and actually see how I approach a problem.

## The problem in 30 seconds

Mexican pharmacies and distributors get invoices from dozens of suppliers, and no two suppliers name the same product the same way. Something as ordinary as *paracetamol 500mg c/10* shows up as `DOLXEN 500MG C/10 TABLETAS`, `DOLXEN 500MG Tabletas c/10`, `dolxen tab. 500mg cja/10`, and about fifteen other variations. Mapping all of that back to a canonical catalog by hand doesn't scale. And the tools that try to do it either over-match (silent false positives that corrupt inventory) or over-flag (the admin's review queue explodes).

The platform handles this — plus a bunch of other pharmacy workflows — by treating the admin's natural language ("I sold 200 of paracetamol", "what ran out today", "process this supplier's invoice") as the primary interface, and routing each request to a specialized agent that owns that job end to end.

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
| [`docs/matcher-evolution.md`](docs/matcher-evolution.md) | How the product matcher went from 27% with hand-rolled rules to **10× less ambiguity** with a hybrid algorithm + LLM judge. The whole story with real numbers, including the fix I had to roll back. |
| [`docs/llm-judge-pattern.md`](docs/llm-judge-pattern.md) | The LLM-as-judge pattern, when it fits, when it doesn't, and how I ship it cheaply (~$0.0019 a decision). |
| [`docs/multi-agent-architecture.md`](docs/multi-agent-architecture.md) | The 8 specialized agents, the intent router, the 4 Haiku tactical sub-agents. |
| [`docs/memory-and-learning.md`](docs/memory-and-learning.md) | Lexical RAG with PostgreSQL `tsvector` (Spanish). Continuous learning without retraining anything. |
| [`docs/augmented-engineering.md`](docs/augmented-engineering.md) | My dev setup: Claude Code + Gemini CLI wired together through two custom MCP connectors and an async mailbox. It's the reason a single developer can ship at this pace. |
| [`docs/rbac-architecture.md`](docs/rbac-architecture.md) | Bank-grade RBAC + ABAC + ReBAC in Postgres: 391 atomic permissions, 76 roles, 4,093 role-permission entries, 30 SoD rules. |
| [`docs/production-infrastructure.md`](docs/production-infrastructure.md) | The 8 production containers, including a dedicated PDP (Policy Decision Point), Keycloak IAM, and Voice Agent v1. |
| [`docs/decisions/`](docs/decisions/) | ADRs — why the big calls were made, what got rejected, and what it cost. |
| [`src/matcher/`](src/matcher/) | The matcher code, sanitized: score-literal, the LLM judge, the orchestrator that ties them together. |
| [`src/memory/`](src/memory/) | The lexical RAG and alias-learning code, sanitized. |
| [`src/cache/`](src/cache/) | The LLM inference cache: SHA-256 keyed, kill-switch aware. |
| [`src/router/`](src/router/) | The intent router (regex L1 + LLM fallback). |
| [`evals/`](evals/) | A reproducible eval suite with anonymized fixtures and the runner that produces the real `summary.json`. Run it yourself. |

## Key results (with evidence)

| Claim | Where to verify in this repo |
|---|---|
| Hybrid algorithm + LLM judge cuts ambiguity **10×** (11.5% → 1.1%) | [`docs/matcher-evolution.md`](docs/matcher-evolution.md) + [`evals/runs/`](evals/runs/) |
| LLM inference cache cuts cost ~80% | [`src/cache/llm-cache.js`](src/cache/llm-cache.js) + [`docs/decisions/004-cache-strategy.md`](docs/decisions/004-cache-strategy.md) |
| ~$0.0019 USD per LLM decision (Claude Haiku 4.5) | [`src/matcher/juez-llm.js`](src/matcher/juez-llm.js) — pricing table & cost tracking |
| Continuous learning without model retraining | [`src/memory/alias-learning.js`](src/memory/alias-learning.js) + schema |
| 391 atomic permissions, 76 roles, 4,093 entries, 30 SoD rules | [`docs/rbac-architecture.md`](docs/rbac-architecture.md) + sample schemas |

## What's not here (and why)

A quick note on the boundary I drew:

- No real client data. The fixtures are anonymized and the suppliers are labeled `Distributor A/B/C/D`.
- No detailed regulatory config for Mexico (COFEPRIS). It's mentioned in the docs, not spelled out.
- No business logic specific to the ERP backend. The Odoo integration stays private.
- No production prompts in full. You can see the structure, not the wording.
- No deploy scripts, no secrets, no infrastructure-as-code. Diagrammed only.

If you're hiring and want a live demo or a deeper code walk-through, [drop me a line](mailto:gael17890@gmail.com).

## Tech stack

**AI/LLM**: Claude (Haiku 4.5, Sonnet 4.6), Gemini (2.5 Flash, Pro), Kimi K2.6, DeepSeek V3, Vercel AI Gateway, Anthropic SDK, Tavily (web search)
**Backend**: Node.js, Python, PostgreSQL (`pgvector`, `ltree`, `tsvector`)
**Frontend**: React (Vite), Vue.js
**Infra**: Docker, Oracle Cloud Infrastructure (ARM), Contabo VPS, Keycloak IAM, nginx
**Dev tooling**: Claude Code + Gemini CLI wired through custom MCP connectors

## About the author

[Gael Alberto Franco Ortiz](https://linkedin.com/in/gael-alberto-franco-ortiz-165a6a418) — Sole Founder and AI Engineer building enterprise SaaS for Mexican pharma. CS50 (Harvard) certified. Open to 100% remote AI Engineer roles, especially in healthcare. Reach me at gael17890@gmail.com.

---

*This repo is a public showcase. The full FOTECH platform is a private commercial product.*
