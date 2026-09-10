import crypto from "crypto";
import { logger } from "../../utils/logger";

const log = logger.child({ module: "embeddings" });

export interface ChunkOptions {
  chunkSize?: number; // Target characters per chunk (default 600)
  overlap?: number;   // Overlap characters between chunks (default 80)
}

/**
 * Intelligent text chunker that respects semantic boundaries
 * (paragraphs, sentence endings, bullet points) before falling back to words.
 */
export function chunkText(text: string, options: ChunkOptions = {}): string[] {
  const chunkSize = options.chunkSize || 600;
  const overlap = options.overlap || 80;

  if (!text || text.trim().length === 0) {
    return [];
  }

  const cleaned = text.replace(/\r\n/g, "\n").trim();
  if (cleaned.length <= chunkSize) {
    return [cleaned];
  }

  const chunks: string[] = [];
  const paragraphs = cleaned.split(/\n\s*\n/);
  let currentChunk = "";

  for (const paragraph of paragraphs) {
    const pTrimmed = paragraph.trim();
    if (!pTrimmed) continue;

    // If adding this paragraph fits comfortably in the current chunk
    if ((currentChunk + "\n\n" + pTrimmed).length <= chunkSize) {
      currentChunk = currentChunk ? currentChunk + "\n\n" + pTrimmed : pTrimmed;
    } else {
      // If current chunk has accumulated content, push it
      if (currentChunk) {
        chunks.push(currentChunk);
        // Retain overlap from end of current chunk
        const overlapSlice = currentChunk.slice(-overlap).trim();
        currentChunk = overlapSlice ? overlapSlice + "\n\n" + pTrimmed : pTrimmed;
      } else {
        currentChunk = pTrimmed;
      }

      // If a single paragraph is still larger than chunkSize, break by sentences
      if (currentChunk.length > chunkSize) {
        const sentences = currentChunk.match(/[^.!?]+[.!?]+(\s+|$)|[^.!?]+$/g) || [currentChunk];
        let subChunk = "";

        for (const sentence of sentences) {
          if ((subChunk + sentence).length <= chunkSize) {
            subChunk += sentence;
          } else {
            if (subChunk) chunks.push(subChunk.trim());
            subChunk = sentence;
          }
        }
        if (subChunk.trim()) {
          chunks.push(subChunk.trim());
        }
        currentChunk = "";
      }
    }
  }

  if (currentChunk && currentChunk.trim().length > 0) {
    chunks.push(currentChunk.trim());
  }

  return chunks.filter((c) => c.length > 10);
}

/**
 * Computes Cosine Similarity between two numeric vectors.
 * Returns a value in the range [0.0, 1.0].
 */
export function cosineSimilarity(vecA: number[], vecB: number[]): number {
  if (!vecA || !vecB || vecA.length === 0 || vecB.length === 0) {
    return 0;
  }

  const len = Math.min(vecA.length, vecB.length);
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < len; i++) {
    const a = vecA[i] || 0;
    const b = vecB[i] || 0;
    dotProduct += a * b;
    normA += a * a;
    normB += b * b;
  }

  if (normA === 0 || normB === 0) {
    return 0;
  }

  const similarity = dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  return Math.max(0, Math.min(1, (similarity + 1) / 2)); // Normalize to 0..1 range
}

/**
 * Generates an embedding vector (1536 dimensions).
 * 1. Uses OpenAI `text-embedding-3-small` if `OPENAI_API_KEY` is provided.
 * 2. Uses deterministic Fast Semantic Hashing & Normalized TF-IDF projection offline/fallback.
 */
export async function generateEmbedding(text: string): Promise<number[]> {
  const openaiKey = process.env.OPENAI_API_KEY;

  if (openaiKey && openaiKey.trim().length > 0 && !openaiKey.includes("placeholder")) {
    try {
      const res = await fetch("https://api.openai.com/v1/embeddings", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${openaiKey}`,
        },
        body: JSON.stringify({
          model: "text-embedding-3-small",
          input: text.slice(0, 8000),
        }),
      });

      if (res.ok) {
        const json: any = await res.json();
        if (json.data?.[0]?.embedding) {
          return json.data[0].embedding;
        }
      } else {
        const errText = await res.text();
        log.warn("OpenAI embedding API returned non-200, falling back to internal semantic vectorizer", {
          status: res.status,
          error: errText,
        });
      }
    } catch (err: any) {
      log.warn("Failed to call OpenAI embedding API, using internal vectorizer", { error: err.message });
    }
  }

  // Internal Fallback: Deterministic 1536-dimensional Semantic Projection
  return generateDeterministicSemanticVector(text, 1536);
}

/**
 * Generates a high-quality deterministic semantic vector using n-gram tokenization,
 * word frequency weighting, and Murmur/MD5 hashing across vector dimensions.
 */
function generateDeterministicSemanticVector(text: string, dimensions = 1536): number[] {
  const vector = new Float64Array(dimensions);
  const normalized = text.toLowerCase().replace(/[^a-z0-9\s_-]/g, " ");
  const words = normalized.split(/\s+/).filter((w) => w.length > 1);

  if (words.length === 0) {
    return Array.from(vector);
  }

  // Word frequency map
  const freqMap = new Map<string, number>();
  for (const word of words) {
    freqMap.set(word, (freqMap.get(word) || 0) + 1);
  }

  // Generate 1-grams, 2-grams and 3-grams
  const ngrams: string[] = [...words];
  for (let i = 0; i < words.length - 1; i++) {
    ngrams.push(`${words[i]}_${words[i + 1]}`);
  }
  for (let i = 0; i < words.length - 2; i++) {
    ngrams.push(`${words[i]}_${words[i + 1]}_${words[i + 2]}`);
  }

  for (const gram of ngrams) {
    const hash = crypto.createHash("md5").update(gram).digest();
    const weight = 1 + Math.log(freqMap.get(gram.split("_")[0]) || 1);

    // Project hash into 4 pseudo-random vector indexes
    for (let k = 0; k < 4; k++) {
      const idx = hash.readUInt16BE(k * 2) % dimensions;
      const sign = (hash[8 + k] % 2 === 0 ? 1 : -1);
      vector[idx] += sign * weight;
    }
  }

  // L2 Normalization (Unit Length)
  let norm = 0;
  for (let i = 0; i < dimensions; i++) {
    norm += vector[i] * vector[i];
  }
  norm = Math.sqrt(norm);

  if (norm > 0) {
    for (let i = 0; i < dimensions; i++) {
      vector[i] = vector[i] / norm;
    }
  }

  return Array.from(vector);
}
