import { query, queryOne, withTransaction } from "../../db/pool";
import { indexContact } from "../search/search.service";
import * as XLSX from "xlsx";

export interface Contact {
  id: string;
  tenant_id: string;
  channel_id: string;
  external_id: string;
  name: string | null;
  attributes: {
    tags?: string[];
    email?: string;
    [key: string]: any;
  };
  created_at: string;
}

export interface ContactImportRow {
  name?: string;
  externalId: string;
  email?: string;
  tags?: string[];
  attributes?: Record<string, any>;
}

export interface ImportResult {
  total: number;
  imported: number;
  updated: number;
  errors: string[];
}

/** Normalize and deduplicate tag strings */
export function normalizeTags(tags?: (string | null | undefined)[] | string): string[] {
  if (!tags) return [];
  if (typeof tags === "string") {
    return Array.from(
      new Set(
        tags
          .split(/[,;\s]+/)
          .map((t) => t.trim().toLowerCase())
          .filter(Boolean)
      )
    );
  }
  return Array.from(
    new Set(
      tags
        .filter((t): t is string => typeof t === "string")
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean)
    )
  );
}

/** Find a contact by (channel, external id), or create it if this is the first time we've seen them. */
export async function findOrCreateContact(params: {
  tenantId: string;
  channelId: string;
  externalId: string;
  name?: string;
  tags?: string[];
  attributes?: Record<string, any>;
}): Promise<Contact> {
  const { tenantId, channelId, externalId, name, tags, attributes = {} } = params;

  const existing = await queryOne<Contact>(
    "SELECT * FROM contacts WHERE channel_id = $1 AND external_id = $2",
    [channelId, externalId]
  );

  if (existing) {
    let shouldUpdate = false;
    let newName = existing.name;
    let newAttributes = existing.attributes || {};

    if (name && name.trim() && !existing.name) {
      newName = name.trim();
      shouldUpdate = true;
    }

    if (tags && tags.length > 0) {
      const existingTags = existing.attributes?.tags || [];
      const mergedTags = normalizeTags([...existingTags, ...tags]);
      newAttributes = { ...newAttributes, tags: mergedTags, ...attributes };
      shouldUpdate = true;
    }

    if (shouldUpdate) {
      const updated = await queryOne<Contact>(
        "UPDATE contacts SET name = $1, attributes = $2 WHERE id = $3 RETURNING *",
        [newName, newAttributes, existing.id]
      );
      return updated || existing;
    }
    return existing;
  }

  const initialAttributes = {
    ...attributes,
    tags: normalizeTags(tags),
  };

  const created = await queryOne<Contact>(
    `INSERT INTO contacts (tenant_id, channel_id, external_id, name, attributes)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [tenantId, channelId, externalId, name || null, initialAttributes]
  );

  await indexContact({
    tenantId,
    contactId: created!.id,
    name: created!.name,
    externalId: created!.external_id,
  }).catch((err) => {
    console.error("[contacts] Elasticsearch indexing failed (non-fatal):", err);
  });

  return created!;
}

/** Create a new contact explicitly */
export async function createContact(params: {
  tenantId: string;
  channelId: string;
  externalId: string;
  name?: string;
  email?: string;
  tags?: string[];
  attributes?: Record<string, any>;
}): Promise<Contact> {
  const { tenantId, channelId, externalId, name, email, tags, attributes = {} } = params;

  const mergedAttributes = {
    ...attributes,
    ...(email ? { email: email.trim() } : {}),
    tags: normalizeTags(tags),
  };

  const contact = await queryOne<Contact>(
    `INSERT INTO contacts (tenant_id, channel_id, external_id, name, attributes)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (channel_id, external_id)
     DO UPDATE SET
       name = COALESCE(EXCLUDED.name, contacts.name),
       attributes = contacts.attributes || EXCLUDED.attributes
     RETURNING *`,
    [tenantId, channelId, externalId.trim(), name?.trim() || null, mergedAttributes]
  );

  if (!contact) throw new Error("Failed to create contact");

  await indexContact({
    tenantId,
    contactId: contact.id,
    name: contact.name,
    externalId: contact.external_id,
  }).catch((err) => {
    console.error("[contacts] Elasticsearch indexing failed (non-fatal):", err);
  });

  return contact;
}

/** Update an existing contact */
export async function updateContact(
  tenantId: string,
  contactId: string,
  params: {
    name?: string;
    email?: string;
    tags?: string[];
    attributes?: Record<string, any>;
  }
): Promise<Contact | null> {
  const existing = await queryOne<Contact>(
    "SELECT * FROM contacts WHERE id = $1 AND tenant_id = $2",
    [contactId, tenantId]
  );
  if (!existing) return null;

  const updatedAttributes = {
    ...existing.attributes,
    ...(params.attributes || {}),
  };

  if (params.email !== undefined) {
    if (params.email) updatedAttributes.email = params.email.trim();
    else delete updatedAttributes.email;
  }

  if (params.tags !== undefined) {
    updatedAttributes.tags = normalizeTags(params.tags);
  }

  const updated = await queryOne<Contact>(
    `UPDATE contacts
     SET name = COALESCE($1, name), attributes = $2
     WHERE id = $3 AND tenant_id = $4 RETURNING *`,
    [params.name !== undefined ? params.name : existing.name, updatedAttributes, contactId, tenantId]
  );

  return updated;
}

/** Delete a contact */
export async function deleteContact(tenantId: string, contactId: string): Promise<boolean> {
  const result = await query(
    "DELETE FROM contacts WHERE id = $1 AND tenant_id = $2 RETURNING id",
    [contactId, tenantId]
  );
  return result.length > 0;
}

/** List contacts with optional filtering by channel, tag, search query */
export async function listContacts(
  tenantId: string,
  options: {
    limit?: number;
    offset?: number;
    channelId?: string;
    tag?: string;
    search?: string;
  } = {}
): Promise<Contact[]> {
  const { limit = 50, offset = 0, channelId, tag, search } = options;
  const conditions: string[] = ["tenant_id = $1"];
  const params: any[] = [tenantId];

  if (channelId) {
    params.push(channelId);
    conditions.push(`channel_id = $${params.length}`);
  }

  if (tag && tag.trim()) {
    params.push(JSON.stringify([tag.trim().toLowerCase()]));
    conditions.push(`attributes->'tags' @> $${params.length}::jsonb`);
  }

  if (search && search.trim()) {
    params.push(`%${search.trim().toLowerCase()}%`);
    const pIdx = params.length;
    conditions.push(`(LOWER(name) LIKE $${pIdx} OR LOWER(external_id) LIKE $${pIdx} OR LOWER(COALESCE(attributes->>'email', '')) LIKE $${pIdx})`);
  }

  params.push(limit, offset);
  const sql = `
    SELECT * FROM contacts
    WHERE ${conditions.join(" AND ")}
    ORDER BY created_at DESC
    LIMIT $${params.length - 1} OFFSET $${params.length}
  `;

  return query<Contact>(sql, params);
}

/** List all distinct tags in use by a tenant */
export async function listTenantTags(tenantId: string): Promise<string[]> {
  const rows = await query<{ tag: string }>(
    `SELECT DISTINCT jsonb_array_elements_text(attributes->'tags') as tag
     FROM contacts
     WHERE tenant_id = $1 AND attributes ? 'tags' AND jsonb_typeof(attributes->'tags') = 'array'
     ORDER BY tag ASC`,
    [tenantId]
  );
  return rows.map((r) => r.tag).filter(Boolean);
}

/** Count contacts matching audience criteria (for instant campaign preview) */
export async function countContactsByFilter(
  tenantId: string,
  filter: {
    channelId?: string;
    tags?: string[];
    search?: string;
  } = {}
): Promise<number> {
  const { channelId, tags, search } = filter;
  const conditions: string[] = ["tenant_id = $1"];
  const params: any[] = [tenantId];

  if (channelId) {
    params.push(channelId);
    conditions.push(`channel_id = $${params.length}`);
  }

  if (tags && tags.length > 0) {
    const cleanTags = normalizeTags(tags);
    if (cleanTags.length > 0) {
      params.push(cleanTags);
      conditions.push(`attributes->'tags' ?| $${params.length}`);
    }
  }

  if (search && search.trim()) {
    params.push(`%${search.trim().toLowerCase()}%`);
    const pIdx = params.length;
    conditions.push(`(LOWER(name) LIKE $${pIdx} OR LOWER(external_id) LIKE $${pIdx})`);
  }

  const result = await queryOne<{ count: string }>(
    `SELECT COUNT(*)::text as count FROM contacts WHERE ${conditions.join(" AND ")}`,
    params
  );

  return result ? parseInt(result.count, 10) : 0;
}

/** Fetch contact IDs matching audience criteria (for campaign creation) */
export async function getContactIdsByFilter(
  tenantId: string,
  filter: {
    channelId?: string;
    tags?: string[];
  } = {}
): Promise<string[]> {
  const { channelId, tags } = filter;
  const conditions: string[] = ["tenant_id = $1"];
  const params: any[] = [tenantId];

  if (channelId) {
    params.push(channelId);
    conditions.push(`channel_id = $${params.length}`);
  }

  if (tags && tags.length > 0) {
    const cleanTags = normalizeTags(tags);
    if (cleanTags.length > 0) {
      params.push(cleanTags);
      conditions.push(`attributes->'tags' ?| $${params.length}`);
    }
  }

  const rows = await query<{ id: string }>(
    `SELECT id FROM contacts WHERE ${conditions.join(" AND ")} ORDER BY created_at DESC`,
    params
  );

  return rows.map((r) => r.id);
}

/** Bulk Import contacts from parsed rows */
export async function importContactsFromRows(
  tenantId: string,
  channelId: string,
  rows: ContactImportRow[],
  defaultTags: string[] = []
): Promise<ImportResult> {
  const normalizedDefaultTags = normalizeTags(defaultTags);
  const result: ImportResult = {
    total: rows.length,
    imported: 0,
    updated: 0,
    errors: [],
  };

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rawExternalId = String(row.externalId || "").trim();

    if (!rawExternalId) {
      result.errors.push(`Row ${i + 1}: Missing external ID / phone number`);
      continue;
    }

    const rowTags = normalizeTags(row.tags);
    const combinedTags = normalizeTags([...rowTags, ...normalizedDefaultTags]);

    const initialAttributes = {
      ...(row.attributes || {}),
      ...(row.email ? { email: row.email.trim() } : {}),
      tags: combinedTags,
    };

    try {
      const existing = await queryOne<Contact>(
        "SELECT id, attributes FROM contacts WHERE channel_id = $1 AND external_id = $2",
        [channelId, rawExternalId]
      );

      if (existing) {
        const existingTags = existing.attributes?.tags || [];
        const mergedTags = normalizeTags([...existingTags, ...combinedTags]);
        const updatedAttrs = {
          ...existing.attributes,
          ...initialAttributes,
          tags: mergedTags,
        };

        await query(
          "UPDATE contacts SET name = COALESCE($1, name), attributes = $2 WHERE id = $3",
          [row.name?.trim() || null, updatedAttrs, existing.id]
        );
        result.updated++;
      } else {
        const created = await queryOne<Contact>(
          `INSERT INTO contacts (tenant_id, channel_id, external_id, name, attributes)
           VALUES ($1, $2, $3, $4, $5) RETURNING id`,
          [tenantId, channelId, rawExternalId, row.name?.trim() || null, initialAttributes]
        );
        if (created) result.imported++;
      }
    } catch (err: any) {
      result.errors.push(`Row ${i + 1} (${rawExternalId}): ${err?.message || "Insert failed"}`);
    }
  }

  return result;
}

/**
 * Parse uploaded buffer (.csv, .xlsx, .xls) into structured ContactImportRow items
 */
export function parseContactsFile(fileBuffer: Buffer): ContactImportRow[] {
  const workbook = XLSX.read(fileBuffer, { type: "buffer" });
  const firstSheetName = workbook.SheetNames[0];
  if (!firstSheetName) return [];

  const worksheet = workbook.Sheets[firstSheetName];
  const jsonData: any[] = XLSX.utils.sheet_to_json(worksheet, { defval: "" });

  const rows: ContactImportRow[] = [];

  for (const item of jsonData) {
    let name: string | undefined;
    let externalId: string | undefined;
    let email: string | undefined;
    let tags: string[] = [];
    const extraAttributes: Record<string, any> = {};

    for (const [rawKey, rawVal] of Object.entries(item)) {
      const key = rawKey.toLowerCase().trim().replace(/[\s_-]+/g, "");
      const val = String(rawVal).trim();
      if (!val) continue;

      if (key === "name" || key === "fullname" || key === "contactname" || key === "customername" || key === "user") {
        name = val;
      } else if (
        key === "phone" ||
        key === "phonenumber" ||
        key === "mobile" ||
        key === "mobilenumber" ||
        key === "externalid" ||
        key === "number" ||
        key === "whatsapp" ||
        key === "whatsappnumber" ||
        key === "id"
      ) {
        // Clean phone number format
        externalId = val.replace(/\s+/g, "");
      } else if (key === "email" || key === "emailaddress" || key === "mail") {
        email = val;
      } else if (key === "tag" || key === "tags" || key === "category" || key === "label" || key === "labels" || key === "group") {
        tags = normalizeTags(val);
      } else {
        extraAttributes[rawKey] = val;
      }
    }

    if (externalId) {
      rows.push({
        name,
        externalId,
        email,
        tags,
        attributes: Object.keys(extraAttributes).length > 0 ? extraAttributes : undefined,
      });
    }
  }

  return rows;
}
