# Exchange Ops

An agent-assisted size-exchange workflow for a fictional online store. Try a request, review the proposed change and inspect the tools, approval attempts and database state.

**[Try the browser demo](https://radusquinho.github.io/exchange-ops/)** · [Portfolio](https://radusquinho.com/)

## Try the lost-response scenario

1. Choose **Response lost after commit** and run the workflow.
2. Approve the proposed exchange. The simulated response disappears after PostgreSQL commits the shipment.
3. Retry approval. The tool returns the existing shipment. The shipment count stays at one, and stock decreases once.

In the stock-drift scenario the remaining unit disappears between proposal and approval. Approval checks inventory again and records no shipment. The trace lets you inspect tool arguments, results and timing.

## Run locally

Use Node.js 24 or later.

```sh
npm ci
npm run dev
npm run evaluate
```

The public demo and default local flow use a rule-based planner for repeatability. Each scenario starts a fresh in-memory PostgreSQL database using [PGlite](https://pglite.dev/docs/api). There are no store accounts, payment endpoints or real shipments.

### Use an Ollama model

With [Ollama running locally](https://ollama.com/download), pull a model that supports [tool calling](https://docs.ollama.com/capabilities/tool-calling):

```sh
ollama pull qwen3:4b
npm run dev
npm run evaluate -- --model
```

Enter the installed model name in the local dashboard to use Ollama. Set `OLLAMA_MODEL` to change the default model in the CLI evaluation. The development server proxies the model request to the local Ollama endpoint.

## Design

- TypeScript orchestrates four typed tools for order lookup, policy checks, inventory checks and proposal creation.
- The shop validates the customer's order and requested size. Tool responses cannot approve a shipment. Approval and rejection are separate application actions.
- The commit uses a PostgreSQL transaction and a unique shipment key per proposal and order. An update conditioned on remaining stock prevents a negative inventory count. A replay returns the committed result instead of applying it again.
- The public build is a static app. PostgreSQL runs inside the browser, so there is no shared database or production authentication in that demo. Run `npm run build` to generate `dist/`.

## Evaluation

The suite checks 25 cases against PostgreSQL, including permission boundaries, missing details, policy limits, repeated preparation, concurrent approvals, a lost response and an inventory change. Checks assert the expected tool outcome and persisted state. Latency excludes database startup.

| Planner | Checks passed | p95 per check on the test PC |
| --- | ---: | ---: |
| Rules | 25/25 | 7 ms |
| Qwen3 1.7B via Ollama 0.40.16 | 24/25 | 5,905 ms |

Qwen3 passed 17 of the 18 cases that called the model. The other seven covered request validation and injected outcomes. Both planners passed the concurrent approval and lost-response cases, each ending with one shipment and one stock decrement.

On the cancelled-order case, Qwen3 stopped after reading the order and skipped the required policy lookup. The trace shows the early stop, and PostgreSQL recorded no proposal or shipment. This comparison is based on a small, deliberately constructed test suite.

To reproduce the model run, pull `qwen3:1.7b` and set `OLLAMA_MODEL=qwen3:1.7b` when calling `npm run evaluate -- --model`. In PowerShell, use `$env:OLLAMA_MODEL = 'qwen3:1.7b'` before running it.

MIT licensed.
