/**
 * How a model served from a local endpoint is named inside Warmstart.
 *
 * A cloud model id names one thing everywhere: `claude-haiku-4-5` is priced, benchmarked and labelled
 * the same on every install. A local server's id names whatever the operator loaded — llama.cpp
 * reports the gguf path it was started with (or its `--alias`), LM Studio and Ollama report their
 * own catalogue names — and the same string could be a cloud id somewhere else (`gpt-oss-120b`
 * served from a laptop is not OpenAI's). So a local model carries the adapter as a namespace:
 *
 *   local-llm:<the id exactly as the server reports it>
 *
 * ⛔ **Verbatim after the prefix.** The id is sent back to the server on every request, and a
 * multi-model server (llama-swap, LM Studio) keys on it exactly; shortening a path to its basename
 * would make a stored choice unroutable. Shortening is for labels only (`localModelLabel`).
 *
 * ⚠️ `src/daemon/adapters/local-llm-bridge.ts` runs without the `@shared` alias and carries its own
 * copy of `LOCAL_MODEL_PREFIX`; keep the two equal.
 */
export const LOCAL_MODEL_PREFIX = 'local-llm:'

/** `Qwen3-Coder.gguf` → `local-llm:Qwen3-Coder.gguf`; already-prefixed ids are left alone. */
export function localModelId(served: string): string {
  const id = served.trim()
  return id.startsWith(LOCAL_MODEL_PREFIX) ? id : `${LOCAL_MODEL_PREFIX}${id}`
}

export function isLocalModelId(id: string | null | undefined): boolean {
  return typeof id === 'string' && id.startsWith(LOCAL_MODEL_PREFIX) && id.length > LOCAL_MODEL_PREFIX.length
}

/** The id the server knows: the prefix removed, nothing else touched. */
export function servedModelOf(id: string): string {
  return id.startsWith(LOCAL_MODEL_PREFIX) ? id.slice(LOCAL_MODEL_PREFIX.length) : id
}

/**
 * What a person reads for a local id: the file or catalogue name, without the directory llama.cpp
 * was pointed at and without `.gguf`. `C:\models\qwen\Qwen3-Coder-30B-A3B-UD-Q3_K_XL.gguf` →
 * `Qwen3-Coder-30B-A3B-UD-Q3_K_XL`; `unsloth/Qwen3.8-27B-GGUF:UD-Q4_K_XL` is kept whole, because
 * the org and the quant are the name there. ⛔ Display only; never parsed back into an id.
 */
export function localModelLabel(id: string): string {
  const served = servedModelOf(id)
  const isPath = /^[A-Za-z]:[\\/]|^[\\/]/.test(served) || served.includes('\\')
  const base = isPath ? (served.split(/[\\/]/).pop() ?? served) : served
  return base.replace(/\.gguf$/i, '') || served
}
