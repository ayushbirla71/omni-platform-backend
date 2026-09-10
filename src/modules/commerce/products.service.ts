import { v4 as uuidv4 } from "uuid";
import { query, queryOne } from "../../db/pool";

export interface Product {
  id: string;
  tenant_id: string;
  tenantId?: string;
  name: string;
  sku: string;
  description: string | null;
  price: number;
  currency: string;
  category: string | null;
  images: string[];
  stock_quantity: number;
  stockQuantity?: number;
  is_available: boolean;
  isAvailable?: boolean;
  metadata: Record<string, any>;
  created_at: string;
  createdAt?: string;
  updated_at: string;
  updatedAt?: string;
}

interface ProductRow {
  id: string;
  tenant_id: string;
  name: string;
  sku: string;
  description: string | null;
  price: string | number;
  currency: string;
  category: string | null;
  images: any;
  stock_quantity: number;
  is_available: boolean;
  metadata: any;
  created_at: string;
  updated_at: string;
}

function formatProduct(row: ProductRow): Product {
  const images = Array.isArray(row.images) ? row.images : [];
  const price = typeof row.price === "number" ? row.price : parseFloat(row.price || "0");
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    tenantId: row.tenant_id,
    name: row.name,
    sku: row.sku,
    description: row.description,
    price,
    currency: row.currency || "INR",
    category: row.category,
    images,
    stock_quantity: row.stock_quantity,
    stockQuantity: row.stock_quantity,
    is_available: row.is_available,
    isAvailable: row.is_available,
    metadata: row.metadata || {},
    created_at: row.created_at,
    createdAt: row.created_at,
    updated_at: row.updated_at,
    updatedAt: row.updated_at,
  };
}

export async function listProducts(
  tenantId: string,
  options: {
    search?: string;
    category?: string;
    isAvailable?: boolean;
    limit?: number;
    offset?: number;
  } = {}
): Promise<{ products: Product[]; total: number }> {
  const { search, category, isAvailable, limit = 50, offset = 0 } = options;

  const conditions: string[] = ["tenant_id = $1"];
  const params: any[] = [tenantId];
  let paramIdx = 2;

  if (search && search.trim()) {
    conditions.push(`(name ILIKE $${paramIdx} OR sku ILIKE $${paramIdx} OR description ILIKE $${paramIdx})`);
    params.push(`%${search.trim()}%`);
    paramIdx++;
  }

  if (category && category.trim()) {
    conditions.push(`category = $${paramIdx}`);
    params.push(category.trim());
    paramIdx++;
  }

  if (typeof isAvailable === "boolean") {
    conditions.push(`is_available = $${paramIdx}`);
    params.push(isAvailable);
    paramIdx++;
  }

  const whereClause = conditions.join(" AND ");

  const countRow = await queryOne<{ count: string }>(
    `SELECT count(*)::text as count FROM products WHERE ${whereClause}`,
    params
  );
  const total = parseInt(countRow?.count || "0", 10);

  const rows = await query<ProductRow>(
    `SELECT * FROM products
     WHERE ${whereClause}
     ORDER BY created_at DESC
     LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
    [...params, Math.min(limit, 100), offset]
  );

  return {
    products: rows.map(formatProduct),
    total,
  };
}

export async function getProduct(tenantId: string, id: string): Promise<Product | null> {
  const row = await queryOne<ProductRow>(
    `SELECT * FROM products WHERE id = $1 AND tenant_id = $2`,
    [id, tenantId]
  );
  return row ? formatProduct(row) : null;
}

export async function getProductBySku(tenantId: string, sku: string): Promise<Product | null> {
  const row = await queryOne<ProductRow>(
    `SELECT * FROM products WHERE sku = $1 AND tenant_id = $2`,
    [sku, tenantId]
  );
  return row ? formatProduct(row) : null;
}

export async function createProduct(
  tenantId: string,
  data: {
    name: string;
    sku: string;
    description?: string | null;
    price: number;
    currency?: string;
    category?: string | null;
    images?: string[];
    stockQuantity?: number;
    isAvailable?: boolean;
    metadata?: Record<string, any>;
  }
): Promise<Product> {
  const id = uuidv4();
  const images = JSON.stringify(data.images || []);
  const metadata = JSON.stringify(data.metadata || {});
  const currency = data.currency || "INR";
  const stockQuantity = data.stockQuantity ?? 0;
  const isAvailable = data.isAvailable ?? true;

  const row = await queryOne<ProductRow>(
    `INSERT INTO products (
      id, tenant_id, name, sku, description, price, currency,
      category, images, stock_quantity, is_available, metadata
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
    RETURNING *`,
    [
      id,
      tenantId,
      data.name.trim(),
      data.sku.trim(),
      data.description || null,
      data.price,
      currency,
      data.category?.trim() || null,
      images,
      stockQuantity,
      isAvailable,
      metadata,
    ]
  );

  if (!row) throw new Error("Failed to insert product");
  return formatProduct(row);
}

export async function updateProduct(
  tenantId: string,
  id: string,
  data: {
    name?: string;
    sku?: string;
    description?: string | null;
    price?: number;
    currency?: string;
    category?: string | null;
    images?: string[];
    stockQuantity?: number;
    isAvailable?: boolean;
    metadata?: Record<string, any>;
  }
): Promise<Product | null> {
  const updates: string[] = ["updated_at = now()"];
  const params: any[] = [id, tenantId];
  let paramIdx = 3;

  if (typeof data.name === "string") {
    updates.push(`name = $${paramIdx}`);
    params.push(data.name.trim());
    paramIdx++;
  }
  if (typeof data.sku === "string") {
    updates.push(`sku = $${paramIdx}`);
    params.push(data.sku.trim());
    paramIdx++;
  }
  if (data.description !== undefined) {
    updates.push(`description = $${paramIdx}`);
    params.push(data.description);
    paramIdx++;
  }
  if (typeof data.price === "number") {
    updates.push(`price = $${paramIdx}`);
    params.push(data.price);
    paramIdx++;
  }
  if (typeof data.currency === "string") {
    updates.push(`currency = $${paramIdx}`);
    params.push(data.currency.trim());
    paramIdx++;
  }
  if (data.category !== undefined) {
    updates.push(`category = $${paramIdx}`);
    params.push(data.category ? data.category.trim() : null);
    paramIdx++;
  }
  if (Array.isArray(data.images)) {
    updates.push(`images = $${paramIdx}`);
    params.push(JSON.stringify(data.images));
    paramIdx++;
  }
  if (typeof data.stockQuantity === "number") {
    updates.push(`stock_quantity = $${paramIdx}`);
    params.push(data.stockQuantity);
    paramIdx++;
  }
  if (typeof data.isAvailable === "boolean") {
    updates.push(`is_available = $${paramIdx}`);
    params.push(data.isAvailable);
    paramIdx++;
  }
  if (data.metadata) {
    updates.push(`metadata = $${paramIdx}`);
    params.push(JSON.stringify(data.metadata));
    paramIdx++;
  }

  const row = await queryOne<ProductRow>(
    `UPDATE products
     SET ${updates.join(", ")}
     WHERE id = $1 AND tenant_id = $2
     RETURNING *`,
    params
  );

  return row ? formatProduct(row) : null;
}

export async function deleteProduct(tenantId: string, id: string): Promise<boolean> {
  const result = await query(
    `DELETE FROM products WHERE id = $1 AND tenant_id = $2`,
    [id, tenantId]
  );
  return result.length > 0;
}

export async function getProductCategories(tenantId: string): Promise<string[]> {
  const rows = await query<{ category: string }>(
    `SELECT DISTINCT category FROM products
     WHERE tenant_id = $1 AND category IS NOT NULL AND category != ''
     ORDER BY category ASC`,
    [tenantId]
  );
  return rows.map((r) => r.category);
}
