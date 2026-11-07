/**
 * Contrato do repositório vetorial — SOMENTE LEITURA.
 * Não há operações de criação, alteração ou exclusão de coleções ou pontos.
 */
import { AdapterError, type AdapterHealth, type AuthContext, type RetrievedRecord } from "./types.ts";
import type { CollectionMapping } from "../retrieval/mapping.ts";

export type { AdapterHealth };

/**
 * Filtro de metadados montado pelo SERVIDOR. Só é aceito para campos listados em
 * `filterableFields` da coleção. Os filtros de organização/permissão são acrescentados
 * pelo conector a partir do AuthContext e não podem ser substituídos.
 */
export type MetadataFilter =
  | { field: string; equals: string | number | boolean }
  | { field: string; anyOf: (string | number)[] }
  | { field: string; range: { gte?: number; lte?: number; gt?: number; lt?: number } };

export interface VectorSearchRequest {
  collection: string;
  vector: number[];
  /** Contexto de autorização confiável (obrigatório). */
  auth: AuthContext;
  limit?: number;
  scoreThreshold?: number;
  filters?: MetadataFilter[];
  signal?: AbortSignal;
}

export interface VectorCollectionHealth {
  name: string;
  exists: boolean;
  /** Dimensão do vetor usado (vectorName), se a coleção existir. */
  dimensions: number | null;
  detail: string;
}

export interface VectorStore {
  readonly kind: string;
  readonly collections: readonly CollectionMapping[];
  health(): Promise<AdapterHealth & { collections?: VectorCollectionHealth[] }>;
  search(req: VectorSearchRequest): Promise<RetrievedRecord[]>;
  close(): Promise<void>;
}

/** Repositório vetorial ausente: deixa explícito que não há busca (não é "nada encontrado"). */
export class UnconfiguredVectorStore implements VectorStore {
  readonly kind = "unconfigured";
  readonly collections: readonly CollectionMapping[] = [];

  async health(): Promise<AdapterHealth> {
    return { configured: false, reachable: false, detail: "Qdrant não configurado" };
  }
  async search(): Promise<RetrievedRecord[]> {
    throw new AdapterError("unavailable", "Qdrant não configurado");
  }
  async close(): Promise<void> {}
}
