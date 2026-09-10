export type AIProviderType = "auto" | "anthropic" | "openai" | "fallback";

export type KnowledgeSourceType = "text" | "faq" | "markdown" | "url" | "pdf";
export type KnowledgeDocumentStatus = "pending" | "indexing" | "indexed" | "failed";

export interface KnowledgeBase {
  id: string;
  tenant_id: string;
  name: string;
  description: string | null;
  system_prompt: string;
  provider: AIProviderType;
  model: string;
  temperature: number;
  is_active: boolean;
  metadata: Record<string, any>;
  created_at: string;
  updated_at: string;
  document_count?: number;
  chunk_count?: number;
}

export interface KnowledgeDocument {
  id: string;
  tenant_id: string;
  knowledge_base_id: string;
  title: string;
  source_type: KnowledgeSourceType;
  source_url: string | null;
  raw_content: string;
  chunk_count: number;
  status: KnowledgeDocumentStatus;
  metadata: Record<string, any>;
  created_at: string;
  updated_at: string;
}

export interface KnowledgeChunk {
  id: string;
  tenant_id: string;
  knowledge_base_id: string;
  document_id: string;
  chunk_index: number;
  content: string;
  token_count: number;
  embedding?: number[] | null;
  metadata?: Record<string, any>;
  created_at: string;
  score?: number; // similarity score during search
  document_title?: string;
}

export interface RAGQueryParams {
  tenantId: string;
  knowledgeBaseId: string;
  query: string;
  conversationId?: string;
  topK?: number;
  threshold?: number;
  customSystemPrompt?: string;
  history?: Array<{ role: "user" | "assistant" | "system"; content: string }>;
}

export interface RAGQueryResult {
  answer: string;
  confidence: number;
  sources: Array<{
    documentId: string;
    documentTitle: string;
    chunkId: string;
    snippet: string;
    similarityScore: number;
  }>;
  model: string;
  provider: string;
  latencyMs: number;
  tokensUsed: number;
}

export type CopilotTone = "professional" | "friendly" | "concise" | "bullet_points" | "translate";

export interface CopilotSuggestResult {
  suggestions: Array<{
    title: string;
    text: string;
    category: "greeting" | "resolution" | "clarification" | "closing" | "commerce";
    confidence: number;
  }>;
  contextSummary?: string;
}

export interface CopilotSummarizeResult {
  summary: string;
  keyPoints: string[];
  sentiment: "positive" | "neutral" | "negative" | "urgent";
  intent: "sales_inquiry" | "support_issue" | "order_status" | "complaint" | "general_faq";
  suggestedAction: string;
  language: string;
}

export interface CopilotRephraseResult {
  original: string;
  rephrased: string;
  tone: CopilotTone;
  targetLanguage?: string;
}

export interface IntentClassificationResult {
  intent: "sales_inquiry" | "support_issue" | "order_status" | "complaint" | "general_faq";
  confidence: number;
  sentiment: "positive" | "neutral" | "negative" | "urgent";
  urgencyScore: number; // 0.0 to 1.0
  entities: Record<string, any>;
}

export interface AILogEntry {
  id: string;
  tenant_id: string;
  conversation_id?: string | null;
  knowledge_base_id?: string | null;
  feature: string;
  prompt?: string;
  response?: string;
  retrieved_chunks?: any[];
  latency_ms?: number;
  tokens_used?: number;
  model?: string;
  sentiment?: string;
  intent?: string;
  created_at: string;
}
