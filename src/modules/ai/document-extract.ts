import path from "path";
import pdfParse from "pdf-parse";
import { KnowledgeSourceType } from "./ai.types";

/** Error carrying an HTTP status so the global errorHandler returns it as-is. */
export class DocumentExtractError extends Error {
  constructor(message: string, public readonly status: number = 400) {
    super(message);
    this.name = "DocumentExtractError";
  }
}

const TEXT_EXTENSIONS = new Set([".md", ".markdown", ".txt"]);
const TEXT_MIME_TYPES = new Set([
  "text/markdown",
  "text/x-markdown",
  "text/plain",
  // Browsers/OSes commonly label .md uploads with these
  "application/octet-stream",
  "",
]);
const PDF_MIME_TYPES = new Set(["application/pdf", "application/x-pdf", "application/octet-stream", ""]);

export const MAX_DOCUMENT_UPLOAD_BYTES = 10 * 1024 * 1024; // 10MB

export interface ExtractedDocument {
  text: string;
  sourceType: Extract<KnowledgeSourceType, "markdown" | "pdf" | "text">;
}

/**
 * Drops NUL bytes and private-use glyphs (icon-font artifacts PDFs often contain) and
 * normalizes line endings so Postgres TEXT and the chunker get clean input.
 */
function normalizeText(raw: string): string {
  return raw
    .replace(/[\0-]/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Extracts plain text from an uploaded knowledge document.
 * Supports Markdown/plain text (.md, .markdown, .txt) and text-based PDFs.
 * Both the file extension and the reported MIME type must be on the allow-list.
 */
export async function extractDocumentText(
  buffer: Buffer,
  filename: string,
  mimetype: string
): Promise<ExtractedDocument> {
  const ext = path.extname(filename || "").toLowerCase();
  const mime = (mimetype || "").toLowerCase();

  if (!buffer || buffer.length === 0) {
    throw new DocumentExtractError("The uploaded file is empty");
  }

  let text: string;
  let sourceType: ExtractedDocument["sourceType"];

  if (TEXT_EXTENSIONS.has(ext)) {
    if (!TEXT_MIME_TYPES.has(mime)) {
      throw new DocumentExtractError(`Unexpected file type "${mimetype}" for a ${ext} file`);
    }
    text = buffer.toString("utf8");
    sourceType = ext === ".txt" ? "text" : "markdown";
  } else if (ext === ".pdf") {
    if (!PDF_MIME_TYPES.has(mime)) {
      throw new DocumentExtractError(`Unexpected file type "${mimetype}" for a .pdf file`);
    }
    // PDFs always start with the "%PDF-" magic header; reject renamed files early.
    if (buffer.subarray(0, 5).toString("latin1") !== "%PDF-") {
      throw new DocumentExtractError("The file is not a valid PDF document");
    }
    try {
      text = (await pdfParse(buffer)).text;
    } catch {
      throw new DocumentExtractError("Could not read this PDF. It may be corrupted or password-protected");
    }
    sourceType = "pdf";
  } else {
    throw new DocumentExtractError("Unsupported file type. Upload a .md, .markdown, .txt or .pdf file");
  }

  const normalized = normalizeText(text);
  if (!normalized) {
    throw new DocumentExtractError(
      sourceType === "pdf"
        ? "No text could be extracted from this PDF. It looks like a scanned/image-only document"
        : "The uploaded file contains no text"
    );
  }

  return { text: normalized, sourceType };
}
