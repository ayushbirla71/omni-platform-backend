-- 006_ai_knowledge_and_copilot.sql
-- Knowledge Bases, RAG Vector Search, AI Copilot & AI Telemetry

-- ─────────────────────────────────────────────────────────────
-- Knowledge Bases (Repositories of grounding documentation)
-- ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS knowledge_bases (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  description     TEXT,
  system_prompt   TEXT DEFAULT 'You are a helpful customer support AI assistant. Ground your answers strictly on the provided knowledge base context. If the answer is not contained in the context, politely state that you do not know or offer to connect with a human agent.',
  provider        TEXT NOT NULL DEFAULT 'auto', -- 'auto' | 'anthropic' | 'openai' | 'fallback'
  model           TEXT NOT NULL DEFAULT 'claude-3-haiku-20240307',
  temperature     NUMERIC(3, 2) NOT NULL DEFAULT 0.20,
  is_active       BOOLEAN NOT NULL DEFAULT true,
  metadata        JSONB NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS knowledge_bases_tenant_idx ON knowledge_bases (tenant_id);
CREATE INDEX IF NOT EXISTS knowledge_bases_active_idx ON knowledge_bases (tenant_id, is_active);

-- ─────────────────────────────────────────────────────────────
-- Knowledge Documents (Uploaded Text, FAQs, Markdown, URLs)
-- ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS knowledge_documents (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  knowledge_base_id UUID NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
  title             TEXT NOT NULL,
  source_type       TEXT NOT NULL DEFAULT 'text' CHECK (source_type IN ('text', 'faq', 'markdown', 'url', 'pdf')),
  source_url        TEXT,
  raw_content       TEXT NOT NULL,
  chunk_count       INTEGER NOT NULL DEFAULT 0,
  status            TEXT NOT NULL DEFAULT 'indexed' CHECK (status IN ('pending', 'indexing', 'indexed', 'failed')),
  metadata          JSONB NOT NULL DEFAULT '{}',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS knowledge_documents_kb_idx ON knowledge_documents (tenant_id, knowledge_base_id);
CREATE INDEX IF NOT EXISTS knowledge_documents_status_idx ON knowledge_documents (tenant_id, status);

-- ─────────────────────────────────────────────────────────────
-- Knowledge Chunks (Text chunks with embedding vectors for RAG)
-- ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS knowledge_chunks (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  knowledge_base_id UUID NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
  document_id       UUID NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
  chunk_index       INTEGER NOT NULL,
  content           TEXT NOT NULL,
  token_count       INTEGER NOT NULL DEFAULT 0,
  embedding         JSONB, -- Array of float values or TF-IDF weights for cosine distance
  metadata          JSONB NOT NULL DEFAULT '{}',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS knowledge_chunks_kb_idx ON knowledge_chunks (tenant_id, knowledge_base_id);
CREATE INDEX IF NOT EXISTS knowledge_chunks_doc_idx ON knowledge_chunks (tenant_id, document_id);

-- ─────────────────────────────────────────────────────────────
-- AI Logs (Telemetry, token usage, Copilot auditing, intent logs)
-- ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS ai_logs (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  conversation_id   UUID REFERENCES conversations(id) ON DELETE SET NULL,
  knowledge_base_id UUID REFERENCES knowledge_bases(id) ON DELETE SET NULL,
  feature           TEXT NOT NULL, -- 'rag_query' | 'copilot_suggest' | 'copilot_summarize' | 'copilot_rephrase' | 'intent_classification' | 'flow_ai_agent'
  prompt            TEXT,
  response          TEXT,
  retrieved_chunks  JSONB DEFAULT '[]',
  latency_ms        INTEGER DEFAULT 0,
  tokens_used       INTEGER DEFAULT 0,
  model             TEXT,
  sentiment         TEXT, -- 'positive' | 'neutral' | 'negative' | 'urgent'
  intent            TEXT, -- 'sales_inquiry' | 'support_issue' | 'order_status' | 'complaint' | 'general_faq'
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ai_logs_tenant_idx ON ai_logs (tenant_id);
CREATE INDEX IF NOT EXISTS ai_logs_conv_idx ON ai_logs (tenant_id, conversation_id);
CREATE INDEX IF NOT EXISTS ai_logs_feature_idx ON ai_logs (tenant_id, feature);
