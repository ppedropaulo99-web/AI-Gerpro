/**
 * Geração de embeddings da PERGUNTA para busca vetorial.
 *
 * O AI Gerpro não presume o modelo de indexação: o modelo deve ser EXATAMENTE o mesmo usado
 * para gerar os vetores das coleções (EMBEDDINGS_MODEL, sem padrão). Outras implementações
 * (ex.: serviço interno de embeddings da Cognitiva) podem implementar `EmbeddingProvider`.
 */
import type { EmbeddingsConfig } from "../config/env.ts";
import { AdapterError, withDeadline, type AdapterHealth } from "../adapters/types.ts";
import type { FetchLike } from "../ollama/client.ts";

export interface EmbeddingProvider {
  readonly model: string;
  /** Dimensão esperada, se configurada. */
  readonly dimensions: number | null;
  embedQuery(text: string, signal?: AbortSignal): Promise<number[]>;
  /** Gera um embedding de teste; `dimensions` = tamanho real do vetor. */
  health(): Promise<AdapterHealth & { dimensions: number | null }>;
}

/** Usa o endpoint local /api/embed do Ollama (nenhum dado sai da máquina). */
export class OllamaEmbeddingProvider implements EmbeddingProvider {
  readonly model: string;
  readonly dimensions: number | null;
  readonly #cfg: EmbeddingsConfig;
  readonly #fetch: FetchLike;

  constructor(cfg: EmbeddingsConfig, fetchImpl: FetchLike = fetch) {
    this.#cfg = cfg;
    this.model = cfg.model;
    this.dimensions = cfg.dimensions;
    this.#fetch = fetchImpl;
  }

  async embedQuery(text: string, signal?: AbortSignal): Promise<number[]> {
    const input = `${this.#cfg.queryPrefix}${text}`;
    return withDeadline(
      async (s) => {
        let res: Response;
        try {
          res = await this.#fetch(`${this.#cfg.baseUrl}/api/embed`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ model: this.model, input, truncate: true }),
            signal: s,
          });
        } catch (err) {
          if (s.aborted) throw err;
          throw new AdapterError("unavailable", "Serviço de embeddings inacessível");
        }
        if (res.status === 404) {
          throw new AdapterError("not_found", `Modelo de embeddings "${this.model}" não encontrado no Ollama (verifique EMBEDDINGS_MODEL)`);
        }
        if (!res.ok) {
          throw new AdapterError("upstream", `Serviço de embeddings respondeu HTTP ${res.status}`);
        }
        const body = (await res.json().catch(() => null)) as { embeddings?: unknown } | null;
        const vec = Array.isArray(body?.embeddings) ? body.embeddings[0] : undefined;
        if (!Array.isArray(vec) || vec.length === 0 || !vec.every((x) => typeof x === "number" && Number.isFinite(x))) {
          throw new AdapterError("upstream", "Resposta de embeddings inválida");
        }
        if (this.dimensions !== null && vec.length !== this.dimensions) {
          throw new AdapterError(
            "invalid_request",
            `Dimensão do embedding (${vec.length}) difere de EMBEDDINGS_DIMENSIONS (${this.dimensions})`,
          );
        }
        return vec as number[];
      },
      this.#cfg.timeoutMs,
      signal,
      "embeddings",
    );
  }

  async health(): Promise<AdapterHealth & { dimensions: number | null }> {
    try {
      const vec = await this.embedQuery("verificação de saúde");
      return { configured: true, reachable: true, detail: `Modelo ${this.model}, dimensão ${vec.length}`, dimensions: vec.length };
    } catch (err) {
      return { configured: true, reachable: false, detail: err instanceof Error ? err.message : "falha", dimensions: null };
    }
  }
}
