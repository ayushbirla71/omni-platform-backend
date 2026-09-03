import { Router, Response } from "express";
import multer from "multer";
import { AuthedRequest, requireAuth } from "../../middleware/auth";
import { asyncHandler } from "../../middleware/async-handler";
import {
  listContacts,
  listTenantTags,
  countContactsByFilter,
  createContact,
  updateContact,
  deleteContact,
  importContactsFromRows,
  parseContactsFile,
  normalizeTags,
} from "./contacts.service";
import { listChannels } from "../channels/channels.service";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB max
});

export const contactsRouter = Router();
contactsRouter.use(requireAuth);

/** List contacts with optional filters */
contactsRouter.get(
  "/",
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const limit = Number(req.query.limit) || 50;
    const offset = Number(req.query.offset) || 0;
    const channelId = req.query.channelId as string | undefined;
    const tag = req.query.tag as string | undefined;
    const search = req.query.search as string | undefined;

    const contacts = await listContacts(req.auth!.tenantId, {
      limit,
      offset,
      channelId,
      tag,
      search,
    });
    res.json(contacts);
  })
);

/** List all distinct tags for the current tenant */
contactsRouter.get(
  "/tags",
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const tags = await listTenantTags(req.auth!.tenantId);
    res.json(tags);
  })
);

/** Get real-time count of contacts matching audience criteria */
contactsRouter.get(
  "/count",
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const channelId = req.query.channelId as string | undefined;
    const tagsParam = req.query.tags as string | undefined;
    const search = req.query.search as string | undefined;

    let tags: string[] | undefined;
    if (tagsParam) {
      tags = normalizeTags(tagsParam);
    }

    const count = await countContactsByFilter(req.auth!.tenantId, {
      channelId,
      tags,
      search,
    });
    res.json({ count });
  })
);

/** Create a single contact */
contactsRouter.post(
  "/",
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    let { channelId, externalId, name, email, tags, attributes } = req.body || {};

    if (!externalId) {
      return res.status(400).json({ error: "externalId / phone number is required" });
    }

    // If channelId not provided, fallback to the first active channel
    if (!channelId) {
      const channels = await listChannels(req.auth!.tenantId);
      if (channels.length === 0) {
        return res.status(400).json({ error: "No channels found for this tenant. Please connect a channel first." });
      }
      channelId = channels[0].id;
    }

    const contact = await createContact({
      tenantId: req.auth!.tenantId,
      channelId,
      externalId,
      name,
      email,
      tags,
      attributes,
    });

    res.status(201).json(contact);
  })
);

/** Update an existing contact */
contactsRouter.patch(
  "/:id",
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const { name, email, tags, attributes } = req.body || {};
    const updated = await updateContact(req.auth!.tenantId, req.params.id, {
      name,
      email,
      tags,
      attributes,
    });

    if (!updated) {
      return res.status(404).json({ error: "Contact not found" });
    }

    res.json(updated);
  })
);

/** Delete a contact */
contactsRouter.delete(
  "/:id",
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const deleted = await deleteContact(req.auth!.tenantId, req.params.id);
    if (!deleted) {
      return res.status(404).json({ error: "Contact not found" });
    }
    res.json({ success: true });
  })
);

/**
 * Upload CSV or Excel file to import contacts with tags
 */
contactsRouter.post(
  "/import",
  upload.single("file"),
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ error: "Please upload a valid CSV or Excel file" });
    }

    let channelId = req.body.channelId as string | undefined;
    const defaultTagsParam = req.body.tags || req.body.defaultTags;
    const defaultTags = defaultTagsParam ? normalizeTags(defaultTagsParam) : [];

    if (!channelId) {
      const channels = await listChannels(req.auth!.tenantId);
      if (channels.length === 0) {
        return res.status(400).json({ error: "No channels found. Connect a channel before importing contacts." });
      }
      channelId = channels[0].id;
    }

    let rows;
    try {
      rows = parseContactsFile(req.file.buffer);
    } catch (parseErr: any) {
      return res.status(400).json({ error: `Failed to parse spreadsheet: ${parseErr.message}` });
    }

    if (rows.length === 0) {
      return res.status(400).json({
        error: "No contact rows found. Ensure the file contains headers like 'Name', 'Phone', 'Email', and 'Tags'.",
      });
    }

    const result = await importContactsFromRows(req.auth!.tenantId, channelId, rows, defaultTags);

    res.json({
      success: true,
      channelId,
      ...result,
    });
  })
);

/** Bulk JSON import */
contactsRouter.post(
  "/bulk",
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    let { channelId, contacts, tags: defaultTagsParam } = req.body || {};

    if (!Array.isArray(contacts) || contacts.length === 0) {
      return res.status(400).json({ error: "contacts must be a non-empty array" });
    }

    if (!channelId) {
      const channels = await listChannels(req.auth!.tenantId);
      if (channels.length === 0) {
        return res.status(400).json({ error: "No channels found. Connect a channel first." });
      }
      channelId = channels[0].id;
    }

    const defaultTags = defaultTagsParam ? normalizeTags(defaultTagsParam) : [];
    const result = await importContactsFromRows(req.auth!.tenantId, channelId, contacts, defaultTags);

    res.json({
      success: true,
      channelId,
      ...result,
    });
  })
);
