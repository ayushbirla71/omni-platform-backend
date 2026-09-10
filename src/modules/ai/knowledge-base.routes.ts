import { Router } from "express";
import { AuthedRequest, requireAuth } from "../../middleware/auth";
import { asyncHandler } from "../../middleware/async-handler";
import { KnowledgeBaseService } from "./knowledge-base.service";

export const knowledgeBaseRouter = Router();
knowledgeBaseRouter.use(requireAuth);

// GET /api/knowledge-bases - List all knowledge bases for tenant
knowledgeBaseRouter.get(
  "/",
  asyncHandler(async (req: AuthedRequest, res) => {
    const tenantId = req.auth!.tenantId;
    const items = await KnowledgeBaseService.listKnowledgeBases(tenantId);
    res.json({ items });
  })
);

// POST /api/knowledge-bases - Create new knowledge base
knowledgeBaseRouter.post(
  "/",
  asyncHandler(async (req: AuthedRequest, res) => {
    const tenantId = req.auth!.tenantId;
    const { name, description, system_prompt, provider, model, temperature, is_active, metadata } = req.body;

    if (!name || typeof name !== "string" || !name.trim()) {
      return res.status(400).json({ error: "Name is required" });
    }

    const kb = await KnowledgeBaseService.createKnowledgeBase(tenantId, {
      name,
      description,
      system_prompt,
      provider,
      model,
      temperature,
      is_active,
      metadata,
    });

    res.status(201).json(kb);
  })
);

// GET /api/knowledge-bases/:id - Get single knowledge base
knowledgeBaseRouter.get(
  "/:id",
  asyncHandler(async (req: AuthedRequest, res) => {
    const tenantId = req.auth!.tenantId;
    const kb = await KnowledgeBaseService.getKnowledgeBase(tenantId, req.params.id);
    if (!kb) {
      return res.status(404).json({ error: "Knowledge base not found" });
    }
    res.json(kb);
  })
);

// PATCH /api/knowledge-bases/:id - Update knowledge base
knowledgeBaseRouter.patch(
  "/:id",
  asyncHandler(async (req: AuthedRequest, res) => {
    const tenantId = req.auth!.tenantId;
    const kb = await KnowledgeBaseService.updateKnowledgeBase(tenantId, req.params.id, req.body);
    if (!kb) {
      return res.status(404).json({ error: "Knowledge base not found" });
    }
    res.json(kb);
  })
);

// DELETE /api/knowledge-bases/:id - Delete knowledge base
knowledgeBaseRouter.delete(
  "/:id",
  asyncHandler(async (req: AuthedRequest, res) => {
    const tenantId = req.auth!.tenantId;
    await KnowledgeBaseService.deleteKnowledgeBase(tenantId, req.params.id);
    res.json({ success: true });
  })
);

// GET /api/knowledge-bases/:id/documents - List documents
knowledgeBaseRouter.get(
  "/:id/documents",
  asyncHandler(async (req: AuthedRequest, res) => {
    const tenantId = req.auth!.tenantId;
    const docs = await KnowledgeBaseService.listDocuments(tenantId, req.params.id);
    res.json({ items: docs });
  })
);

// POST /api/knowledge-bases/:id/documents - Add document & auto-index
knowledgeBaseRouter.post(
  "/:id/documents",
  asyncHandler(async (req: AuthedRequest, res) => {
    const tenantId = req.auth!.tenantId;
    const { title, source_type, source_url, raw_content, metadata } = req.body;

    if (!title || typeof title !== "string" || !title.trim()) {
      return res.status(400).json({ error: "Title is required" });
    }
    if (!raw_content || typeof raw_content !== "string" || !raw_content.trim()) {
      return res.status(400).json({ error: "Content is required" });
    }

    const doc = await KnowledgeBaseService.addDocument(tenantId, req.params.id, {
      title,
      source_type: source_type || "text",
      source_url,
      raw_content,
      metadata,
    });

    res.status(201).json(doc);
  })
);

// DELETE /api/knowledge-bases/:id/documents/:docId - Delete document
knowledgeBaseRouter.delete(
  "/:id/documents/:docId",
  asyncHandler(async (req: AuthedRequest, res) => {
    const tenantId = req.auth!.tenantId;
    await KnowledgeBaseService.deleteDocument(tenantId, req.params.id, req.params.docId);
    res.json({ success: true });
  })
);

// POST /api/knowledge-bases/:id/search - Test similarity chunk search
knowledgeBaseRouter.post(
  "/:id/search",
  asyncHandler(async (req: AuthedRequest, res) => {
    const tenantId = req.auth!.tenantId;
    const { query: queryText, limit } = req.body;

    if (!queryText || typeof queryText !== "string") {
      return res.status(400).json({ error: "Query string is required" });
    }

    const results = await KnowledgeBaseService.searchChunks(
      tenantId,
      req.params.id,
      queryText,
      limit ? parseInt(String(limit), 10) : 5
    );

    res.json({ results });
  })
);
