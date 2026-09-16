# A local model is whatever the server serves — design of record

**2026-09-16 · t486 · design of record, not status.** Status lives in `HANDOFF.md`; the maintained
description is `docs/cost-model.md` §8a.

## 1. What was wrong, measured on this checkout

`worker.defaultModel` is a free string and the bridge passes `LOCAL_LLM_MODEL` through, so the pin
was not in the adapter. It was in the **cost model**: `costmodels/local.llm.2026-09.json` declared
exactly one model, `qwen3-coder-30b-a3b`, and

- every model write is validated by `cm.modelSpec(id)` (`api/support.ts` — *"not a model Local LLM
  can be priced for"*), so nothing else could be set;
- the picker lists `cm.modelIds()` (`api/workers.ts` `model.options`), so nothing else was offered;
- `defaultGradingModel` / `defaultSummarisingModel` (`workers.ts`) and migrations 44 and 61 wrote it
  to every local worker.

llama.cpp ignores the `model` field on a single-model server, so the operator's second server
(`start-qwen38-27b.ps1`, port 8090, Qwen3.8-27B) answered every request and every run, cost row and
quality grade recorded `qwen3-coder-30b-a3b`. The recorded name was a claim nobody had checked.

Both start scripts pass `-m <gguf>` and no `--alias`, so llama.cpp will report the model id as the
gguf path (`C:\models\qwen3-coder\Qwen3-Coder-30B-A3B-Instruct-UD-Q3_K_XL.gguf`) or, when fetched,
the HF ref (`unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF:UD-Q3_K_XL`).

## 2. Decisions (operator, 2026-09-16)

1. **Id scheme: `local-llm:<served id verbatim>`.** Chosen over storing the basename: the id is sent
   back to the server on every request and a multi-model server (llama-swap, LM Studio, Ollama)
   keys on it exactly. Labels shorten (`localModelLabel`: file name, no `.gguf`); ids never do.
   Recommended, not done here: add `--alias qwen3-coder-30b-a3b` / `--alias qwen3.8-27b` to the two
   start scripts so the ids are short. They live outside this repository.
2. **Existing pins are cleared to null** (migration 74), meaning "the server's model". Chosen over
   rewriting to `local-llm:qwen3-coder-30b-a3b`, which would not match what either server reports.
3. **Measure against a running server.** The operator started both; neither answered during the
   run (see §5).

## 3. How the name flows

```
server /v1/models ──probeIdentity──▶ identity.servedModels = ['local-llm:<id>', …]   (every refresh)
server /props     ──probeIdentity──▶ identity.contextWindow = n_ctx                  (llama.cpp only)
                                          │
              knownModelIds(adapter, worker?) = cost model's list ∪ served ids
                                          │
        model.options ── adapter-wide entry (a task constraint) + one entry per local worker
                                          │
   Workers.tsx picker ── "Server's model" (null) or one of the served ids, labelled by file name
                                          │
   dispatch: LOCAL_LLM_MODEL = stored id (prefixed) ── bridge strips the prefix for the API,
             or, when null, asks /v1/models and takes the first
                                          │
   bridge init { model: 'local-llm:<id>' } ──▶ noteModelChosen(session)   (only where model was null)
                                                noteReviewerModel(review) (only where the grade had none)
```

`CostModel.modelSpec(id)` synthesises the `dynamic_models` template for any id under `id_prefix`,
and nothing for the bare prefix or a name outside it — so validation, allowlists, pool lookups,
context-window lookups and pricing (all null: unpriced) work for any served model, and a cloud
adapter never accepts a `local-llm:` id. `contextWindowFor` (`sessions.ts`) prefers the worker's
reported window over the template's.

## 4. What is pinned where

| Claim | Test |
|---|---|
| id round-trip, label shapes, namespace check | `src/daemon/localmodel.test.ts` |
| benchmark prior matches the family on the file name, says so | same |
| migration 74 clears only the pinned literal | same, by `versionBefore` replay |
| `knownModelIds` per worker and union; `model.options` entries | same |
| bare-name refusal names the namespace; cloud adapters refuse the namespace | same |
| `noteModelChosen` writes only over null; reported window wins | same |
| dynamic template accepted, bare prefix refused | `adapters.test.ts` |
| probe stores served ids verbatim and `/props` `n_ctx` | `adapters/local-llm.test.ts` |
| bridge `init` names the prefixed id | same |
| reviewer leaves the model to the server; a chosen served model is used | `reviewer.test.ts` |

## 5. Unmeasured

- **The real servers.** `Get-Process llama*` found nothing and nothing listened on 8080/8090 at
  three checks over ~40 minutes after the operator reported starting both. What `/v1/models`
  actually returns for these two scripts (path vs HF ref), and `/props` → `n_ctx`, is still
  inferred from llama.cpp's server documentation. The first Probe on a local worker answers it.
- A run on a local worker with no default, end to end: the session's model going from null to the
  served id on `init`, and a quality grade filed with that name.
