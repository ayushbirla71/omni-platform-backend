import { query, queryOne, withTransaction } from "../../db/pool";
import {
  KnowledgeBase,
  KnowledgeDocument,
  KnowledgeChunk,
  KnowledgeSourceType,
} from "./ai.types";
import { chunkText, generateEmbedding, cosineSimilarity } from "./embeddings.service";
import { logger } from "../../utils/logger";

const log = logger.child({ module: "knowledge-base-service" });

export class KnowledgeBaseService {
  /**
   * Lists all Knowledge Bases for a tenant with aggregate stats (document count, chunk count).
   */
  public static async listKnowledgeBases(tenantId: string): Promise<KnowledgeBase[]> {
    const rows = await query<KnowledgeBase>(
      `SELECT
         kb.*,
         COALESCE(COUNT(DISTINCT kd.id), 0)::INTEGER AS document_count,
         COALESCE(COUNT(kc.id), 0)::INTEGER AS chunk_count
       FROM knowledge_bases kb
       LEFT JOIN knowledge_documents kd ON kd.knowledge_base_id = kb.id AND kd.tenant_id = kb.tenant_id
       LEFT JOIN knowledge_chunks kc ON kc.knowledge_base_id = kb.id AND kc.tenant_id = kb.tenant_id
       WHERE kb.tenant_id = $1
       GROUP BY kb.id
       ORDER BY kb.created_at DESC`,
      [tenantId]
    );
    return rows;
  }

  /**
   * Retrieves a single Knowledge Base by ID.
   */
  public static async getKnowledgeBase(tenantId: string, id: string): Promise<KnowledgeBase | null> {
    const row = await queryOne<KnowledgeBase>(
      `SELECT
         kb.*,
         COALESCE(COUNT(DISTINCT kd.id), 0)::INTEGER AS document_count,
         COALESCE(COUNT(kc.id), 0)::INTEGER AS chunk_count
       FROM knowledge_bases kb
       LEFT JOIN knowledge_documents kd ON kd.knowledge_base_id = kb.id AND kd.tenant_id = kb.tenant_id
       LEFT JOIN knowledge_chunks kc ON kc.knowledge_base_id = kb.id AND kc.tenant_id = kb.tenant_id
       WHERE kb.id = $1 AND kb.tenant_id = $2
       GROUP BY kb.id`,
      [id, tenantId]
    );
    return row;
  }

  /**
   * Creates a new Knowledge Base.
   */
  public static async createKnowledgeBase(
    tenantId: string,
    data: {
      name: string;
      description?: string;
      system_prompt?: string;
      provider?: string;
      model?: string;
      temperature?: number;
      is_active?: boolean;
      metadata?: Record<string, any>;
    }
  ): Promise<KnowledgeBase> {
    const row = await queryOne<KnowledgeBase>(
      `INSERT INTO knowledge_bases (
         tenant_id, name, description, system_prompt, provider, model, temperature, is_active, metadata
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        tenantId,
        data.name.trim(),
        data.description?.trim() || null,
        data.system_prompt?.trim() || "You are a helpful customer support AI assistant. Ground your answers strictly on the provided knowledge base context.",
        data.provider || "auto",
        data.model || "claude-3-haiku-20240307",
        data.temperature ?? 0.2,
        data.is_active !== undefined ? data.is_active : true,
        JSON.stringify(data.metadata || {}),
      ]
    );
    if (!row) throw new Error("Failed to create knowledge base");
    return { ...row, document_count: 0, chunk_count: 0 };
  }

  /**
   * Updates an existing Knowledge Base.
   */
  public static async updateKnowledgeBase(
    tenantId: string,
    id: string,
    data: {
      name?: string;
      description?: string;
      system_prompt?: string;
      provider?: string;
      model?: string;
      temperature?: number;
      is_active?: boolean;
      metadata?: Record<string, any>;
    }
  ): Promise<KnowledgeBase | null> {
    const fields: string[] = [];
    const values: any[] = [];
    let idx = 1;

    if (data.name !== undefined) {
      fields.push(`name = $${idx++}`);
      values.push(data.name.trim());
    }
    if (data.description !== undefined) {
      fields.push(`description = $${idx++}`);
      values.push(data.description.trim());
    }
    if (data.system_prompt !== undefined) {
      fields.push(`system_prompt = $${idx++}`);
      values.push(data.system_prompt.trim());
    }
    if (data.provider !== undefined) {
      fields.push(`provider = $${idx++}`);
      values.push(data.provider);
    }
    if (data.model !== undefined) {
      fields.push(`model = $${idx++}`);
      values.push(data.model);
    }
    if (data.temperature !== undefined) {
      fields.push(`temperature = $${idx++}`);
      values.push(data.temperature);
    }
    if (data.is_active !== undefined) {
      fields.push(`is_active = $${idx++}`);
      values.push(data.is_active);
    }
    if (data.metadata !== undefined) {
      fields.push(`metadata = $${idx++}`);
      values.push(JSON.stringify(data.metadata));
    }

    if (fields.length === 0) {
      return this.getKnowledgeBase(tenantId, id);
    }

    fields.push(`updated_at = now()`);
    values.push(id, tenantId);

    const row = await queryOne<KnowledgeBase>(
      `UPDATE knowledge_bases
       SET ${fields.join(", ")}
       WHERE id = $${idx++} AND tenant_id = $${idx++}
       RETURNING *`,
      values
    );

    return row ? this.getKnowledgeBase(tenantId, id) : null;
  }

  /**
   * Deletes a Knowledge Base and all cascading documents and chunks.
   */
  public static async deleteKnowledgeBase(tenantId: string, id: string): Promise<boolean> {
    const result = await query(
      `DELETE FROM knowledge_bases WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId]
    );
    return true;
  }

  /**
   * Lists all documents in a Knowledge Base.
   */
  public static async listDocuments(tenantId: string, knowledgeBaseId: string): Promise<KnowledgeDocument[]> {
    return query<KnowledgeDocument>(
      `SELECT * FROM knowledge_documents
       WHERE tenant_id = $1 AND knowledge_base_id = $2
       ORDER BY created_at DESC`,
      [tenantId, knowledgeBaseId]
    );
  }

  /**
   * Adds and indexes a new document into a Knowledge Base.
   * Chunks text, computes embeddings, and stores in Postgres.
   */
  public static async addDocument(
    tenantId: string,
    knowledgeBaseId: string,
    data: {
      title: string;
      source_type: KnowledgeSourceType;
      source_url?: string;
      raw_content: string;
      metadata?: Record<string, any>;
    }
  ): Promise<KnowledgeDocument> {
    // 1. Verify KB exists
    const kb = await queryOne(
      `SELECT id FROM knowledge_bases WHERE id = $1 AND tenant_id = $2`,
      [knowledgeBaseId, tenantId]
    );
    if (!kb) {
      throw new Error("Knowledge base not found");
    }

    // 2. Insert document in 'indexing' state
    const doc = await queryOne<KnowledgeDocument>(
      `INSERT INTO knowledge_documents (
         tenant_id, knowledge_base_id, title, source_type, source_url, raw_content, chunk_count, status, metadata
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        tenantId,
        knowledgeBaseId,
        data.title.trim(),
        data.source_type || "text",
        data.source_url?.trim() || null,
        data.raw_content.trim(),
        0,
        "indexing",
        JSON.stringify(data.metadata || {}),
      ]
    );

    if (!doc) {
      throw new Error("Failed to insert document");
    }

    try {
      // 3. Chunk text
      const chunks = chunkText(data.raw_content, { chunkSize: 600, overlap: 80 });

      // 4. Generate embeddings and store chunks
      for (let i = 0; i < chunks.length; i++) {
        const chunkContent = chunks[i];
        const embedding = await generateEmbedding(chunkContent);
        const tokenEstimate = Math.ceil(chunkContent.length / 4);

        await query(
          `INSERT INTO knowledge_chunks (
             tenant_id, knowledge_base_id, document_id, chunk_index, content, token_count, embedding, metadata
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            tenantId,
            knowledgeBaseId,
            doc.id,
            i,
            chunkContent,
            tokenEstimate,
            JSON.stringify(embedding),
            JSON.stringify({ charLength: chunkContent.length }),
          ]
        );
      }

      // 5. Update document status to 'indexed'
      const updatedDoc = await queryOne<KnowledgeDocument>(
        `UPDATE knowledge_documents
         SET chunk_count = $1, status = 'indexed', updated_at = now()
         WHERE id = $2 AND tenant_id = $3
         RETURNING *`,
        [chunks.length, doc.id, tenantId]
      );

      return updatedDoc || doc;
    } catch (err: any) {
      log.error("Failed to index document chunks", err);
      await query(
        `UPDATE knowledge_documents SET status = 'failed', updated_at = now() WHERE id = $1 AND tenant_id = $2`,
        [doc.id, tenantId]
      );
      throw err;
    }
  }

  /**
   * Deletes a document and its associated chunks.
   */
  public static async deleteDocument(
    tenantId: string,
    knowledgeBaseId: string,
    documentId: string
  ): Promise<boolean> {
    await query(
      `DELETE FROM knowledge_documents
       WHERE id = $1 AND knowledge_base_id = $2 AND tenant_id = $3`,
      [documentId, knowledgeBaseId, tenantId]
    );
    return true;
  }

  /**
   * Performs a semantic similarity search across chunks in a Knowledge Base (for testing & diagnostics).
   */
  public static async searchChunks(
    tenantId: string,
    knowledgeBaseId: string,
    queryText: string,
    limit = 5
  ): Promise<Array<KnowledgeChunk & { score: number; document_title: string }>> {
    const queryEmbedding = await generateEmbedding(queryText);

    const rawChunks = await query<{
      id: string;
      tenant_id: string;
      knowledge_base_id: string;
      document_id: string;
      chunk_index: number;
      content: string;
      token_count: number;
      embedding: string | number[] | null;
      metadata: any;
      created_at: string;
      document_title: string;
    }>(
      `SELECT kc.*, kd.title as document_title
       FROM knowledge_chunks kc
       JOIN knowledge_documents kd ON kc.document_id = kd.id
       WHERE kc.tenant_id = $1 AND kc.knowledge_base_id = $2`,
      [tenantId, knowledgeBaseId]
    );

    const scored: Array<KnowledgeChunk & { score: number; document_title: string }> = [];

    for (const c of rawChunks) {
      let vec: number[] | null = null;
      if (Array.isArray(c.embedding)) {
        vec = c.embedding;
      } else if (typeof c.embedding === "string") {
        try {
          vec = JSON.parse(c.embedding);
        } catch {
          vec = null;
        }
      }

      if (vec && vec.length > 0) {
        const score = cosineSimilarity(queryEmbedding, vec);
        scored.push({
          id: c.id,
          tenant_id: c.tenant_id,
          knowledge_base_id: c.knowledge_base_id,
          document_id: c.document_id,
          chunk_index: c.chunk_index,
          content: c.content,
          token_count: c.token_count,
          metadata: c.metadata,
          created_at: c.created_at,
          document_title: c.document_title,
          score: Math.round(score * 1000) / 1000,
        });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  }
}
