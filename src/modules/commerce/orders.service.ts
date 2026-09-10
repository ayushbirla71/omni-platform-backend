import { v4 as uuidv4 } from "uuid";
import { query, queryOne } from "../../db/pool";

export interface OrderItem {
  productId?: string;
  sku: string;
  name: string;
  quantity: number;
  unitPrice: number;
  total: number;
}

export type OrderStatus =
  | "pending"
  | "paid"
  | "processing"
  | "shipped"
  | "completed"
  | "cancelled"
  | "refunded";

export type PaymentStatus =
  | "pending"
  | "authorized"
  | "captured"
  | "failed"
  | "refunded";

export interface Order {
  id: string;
  tenant_id: string;
  tenantId?: string;
  contact_id: string;
  contactId?: string;
  contact_name?: string | null;
  contactName?: string | null;
  contact_external_id?: string;
  contactExternalId?: string;
  conversation_id?: string | null;
  conversationId?: string | null;
  order_number: string;
  orderNumber?: string;
  status: OrderStatus;
  currency: string;
  total_amount: number;
  totalAmount?: number;
  items: OrderItem[];
  shipping_address?: Record<string, any> | null;
  shippingAddress?: Record<string, any> | null;
  payment_status: PaymentStatus;
  paymentStatus?: PaymentStatus;
  payment_method?: string | null;
  paymentMethod?: string | null;
  payment_link?: string | null;
  paymentLink?: string | null;
  metadata: Record<string, any>;
  created_at: string;
  createdAt?: string;
  updated_at: string;
  updatedAt?: string;
}

interface OrderRow {
  id: string;
  tenant_id: string;
  contact_id: string;
  conversation_id: string | null;
  order_number: string;
  status: OrderStatus;
  currency: string;
  total_amount: string | number;
  items: any;
  shipping_address: any;
  payment_status: PaymentStatus;
  payment_method: string | null;
  payment_link: string | null;
  metadata: any;
  created_at: string;
  updated_at: string;
  contact_name?: string | null;
  contact_external_id?: string;
}

function formatOrder(row: OrderRow): Order {
  const items: OrderItem[] = Array.isArray(row.items) ? row.items : [];
  const totalAmount =
    typeof row.total_amount === "number"
      ? row.total_amount
      : parseFloat(row.total_amount || "0");

  return {
    id: row.id,
    tenant_id: row.tenant_id,
    tenantId: row.tenant_id,
    contact_id: row.contact_id,
    contactId: row.contact_id,
    contact_name: row.contact_name || null,
    contactName: row.contact_name || null,
    contact_external_id: row.contact_external_id,
    contactExternalId: row.contact_external_id,
    conversation_id: row.conversation_id,
    conversationId: row.conversation_id,
    order_number: row.order_number,
    orderNumber: row.order_number,
    status: row.status,
    currency: row.currency || "INR",
    total_amount: totalAmount,
    totalAmount,
    items,
    shipping_address: row.shipping_address || null,
    shippingAddress: row.shipping_address || null,
    payment_status: row.payment_status || "pending",
    paymentStatus: row.payment_status || "pending",
    payment_method: row.payment_method,
    paymentMethod: row.payment_method,
    payment_link: row.payment_link,
    paymentLink: row.payment_link,
    metadata: row.metadata || {},
    created_at: row.created_at,
    createdAt: row.created_at,
    updated_at: row.updated_at,
    updatedAt: row.updated_at,
  };
}

function generateOrderNumber(): string {
  const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const randomSuffix = Math.floor(1000 + Math.random() * 9000);
  return `ORD-${dateStr}-${randomSuffix}`;
}

export async function listOrders(
  tenantId: string,
  options: {
    status?: OrderStatus;
    paymentStatus?: PaymentStatus;
    contactId?: string;
    conversationId?: string;
    search?: string;
    limit?: number;
    offset?: number;
  } = {}
): Promise<{ orders: Order[]; total: number }> {
  const { status, paymentStatus, contactId, conversationId, search, limit = 50, offset = 0 } = options;

  const conditions: string[] = ["o.tenant_id = $1"];
  const params: any[] = [tenantId];
  let paramIdx = 2;

  if (status) {
    conditions.push(`o.status = $${paramIdx}`);
    params.push(status);
    paramIdx++;
  }

  if (paymentStatus) {
    conditions.push(`o.payment_status = $${paramIdx}`);
    params.push(paymentStatus);
    paramIdx++;
  }

  if (contactId) {
    conditions.push(`o.contact_id = $${paramIdx}`);
    params.push(contactId);
    paramIdx++;
  }

  if (conversationId) {
    conditions.push(`o.conversation_id = $${paramIdx}`);
    params.push(conversationId);
    paramIdx++;
  }

  if (search && search.trim()) {
    conditions.push(`(o.order_number ILIKE $${paramIdx} OR c.name ILIKE $${paramIdx} OR c.external_id ILIKE $${paramIdx})`);
    params.push(`%${search.trim()}%`);
    paramIdx++;
  }

  const whereClause = conditions.join(" AND ");

  const countRow = await queryOne<{ count: string }>(
    `SELECT count(*)::text as count
     FROM orders o
     JOIN contacts c ON c.id = o.contact_id
     WHERE ${whereClause}`,
    params
  );
  const total = parseInt(countRow?.count || "0", 10);

  const rows = await query<OrderRow>(
    `SELECT o.*, c.name AS contact_name, c.external_id AS contact_external_id
     FROM orders o
     JOIN contacts c ON c.id = o.contact_id
     WHERE ${whereClause}
     ORDER BY o.created_at DESC
     LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
    [...params, Math.min(limit, 100), offset]
  );

  return {
    orders: rows.map(formatOrder),
    total,
  };
}

export async function getOrder(tenantId: string, id: string): Promise<Order | null> {
  const row = await queryOne<OrderRow>(
    `SELECT o.*, c.name AS contact_name, c.external_id AS contact_external_id
     FROM orders o
     JOIN contacts c ON c.id = o.contact_id
     WHERE o.id = $1 AND o.tenant_id = $2`,
    [id, tenantId]
  );
  return row ? formatOrder(row) : null;
}

export async function createOrder(
  tenantId: string,
  data: {
    contactId: string;
    conversationId?: string | null;
    items: Array<{
      productId?: string;
      sku?: string;
      name: string;
      quantity: number;
      unitPrice: number;
    }>;
    currency?: string;
    shippingAddress?: Record<string, any> | null;
    paymentMethod?: string;
    metadata?: Record<string, any>;
  }
): Promise<Order> {
  const id = uuidv4();
  const orderNumber = generateOrderNumber();
  const currency = data.currency || "INR";

  // Compute calculated items and total amount
  let totalAmount = 0;
  const processedItems: OrderItem[] = data.items.map((item) => {
    const qty = Math.max(1, item.quantity || 1);
    const unitPrice = item.unitPrice || 0;
    const itemTotal = Number((qty * unitPrice).toFixed(2));
    totalAmount += itemTotal;
    return {
      productId: item.productId,
      sku: item.sku || `SKU-${Date.now()}`,
      name: item.name,
      quantity: qty,
      unitPrice,
      total: itemTotal,
    };
  });
  totalAmount = Number(totalAmount.toFixed(2));

  const itemsJson = JSON.stringify(processedItems);
  const shippingJson = data.shippingAddress ? JSON.stringify(data.shippingAddress) : null;
  const metadataJson = JSON.stringify(data.metadata || {});

  const row = await queryOne<OrderRow>(
    `INSERT INTO orders (
      id, tenant_id, contact_id, conversation_id, order_number,
      status, currency, total_amount, items, shipping_address,
      payment_status, payment_method, metadata
    ) VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7, $8, $9, 'pending', $10, $11)
    RETURNING *`,
    [
      id,
      tenantId,
      data.contactId,
      data.conversationId || null,
      orderNumber,
      currency,
      totalAmount,
      itemsJson,
      shippingJson,
      data.paymentMethod || null,
      metadataJson,
    ]
  );

  if (!row) throw new Error("Failed to create order");

  // Fetch full details with contact info
  const fullOrder = await getOrder(tenantId, id);
  return fullOrder || formatOrder(row);
}

export async function updateOrderStatus(
  tenantId: string,
  id: string,
  status: OrderStatus,
  paymentStatus?: PaymentStatus
): Promise<Order | null> {
  const updates = ["status = $3", "updated_at = now()"];
  const params: any[] = [id, tenantId, status];

  if (paymentStatus) {
    updates.push("payment_status = $4");
    params.push(paymentStatus);
  }

  await query(
    `UPDATE orders
     SET ${updates.join(", ")}
     WHERE id = $1 AND tenant_id = $2`,
    params
  );

  return getOrder(tenantId, id);
}

export async function setOrderPaymentLink(
  tenantId: string,
  id: string,
  paymentLink: string,
  paymentMethod?: string
): Promise<Order | null> {
  await query(
    `UPDATE orders
     SET payment_link = $3,
         payment_method = COALESCE($4, payment_method),
         updated_at = now()
     WHERE id = $1 AND tenant_id = $2`,
    [id, tenantId, paymentLink, paymentMethod || null]
  );
  return getOrder(tenantId, id);
}

export async function getOrderStats(tenantId: string): Promise<{
  totalOrders: number;
  totalRevenue: number;
  pendingCount: number;
  paidCount: number;
  completedCount: number;
}> {
  const row = await queryOne<{
    total_orders: string;
    total_revenue: string;
    pending_count: string;
    paid_count: string;
    completed_count: string;
  }>(
    `SELECT
       count(*)::text AS total_orders,
       COALESCE(SUM(CASE WHEN payment_status = 'captured' OR status IN ('paid', 'processing', 'shipped', 'completed') THEN total_amount ELSE 0 END), 0)::text AS total_revenue,
       count(*) FILTER (WHERE status = 'pending')::text AS pending_count,
       count(*) FILTER (WHERE status = 'paid' OR payment_status = 'captured')::text AS paid_count,
       count(*) FILTER (WHERE status = 'completed')::text AS completed_count
     FROM orders
     WHERE tenant_id = $1`,
    [tenantId]
  );

  return {
    totalOrders: parseInt(row?.total_orders || "0", 10),
    totalRevenue: parseFloat(row?.total_revenue || "0"),
    pendingCount: parseInt(row?.pending_count || "0", 10),
    paidCount: parseInt(row?.paid_count || "0", 10),
    completedCount: parseInt(row?.completed_count || "0", 10),
  };
}
