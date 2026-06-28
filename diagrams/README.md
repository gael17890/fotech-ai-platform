# Diagrams

Source files for the architecture diagrams referenced in the docs.

## How to render

The diagrams are written in [Mermaid](https://mermaid.js.org). Two easy ways to view them:

**Online** — open the source file, copy the contents, paste at [mermaid.live](https://mermaid.live).

**Locally** with the Mermaid CLI (`mmdc`):

```bash
npm install -g @mermaid-js/mermaid-cli
mmdc -i architecture.mmd -o architecture.svg
mmdc -i llm-judge-flow.mmd -o llm-judge-flow.svg
```

## Files

| File | Shows |
|---|---|
| [`architecture.mmd`](architecture.mmd) | The platform end to end: admin → router → 8 agents → 4 sub-agents → AFF pipeline → cross-cutting services |
| [`llm-judge-flow.mmd`](llm-judge-flow.mmd) | The matcher's decision flow: alias → score literal → top-1 thresholds → LLM judge (when ambiguous) → output |

The diagrams stay in source form so they can be diffed, version-controlled, and updated as the architecture evolves. Rendered SVGs are not committed (they go stale faster than the source).
