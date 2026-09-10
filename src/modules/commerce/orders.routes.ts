import { Router } from "express";
import { AuthedRequest, requireAuth } from "../../middleware/auth";
import { asyncHandler } from "../../middleware/async-handler";
import {
  createOrder,
  getOrder,
  getOrderStats,
  listOrders,
  OrderStatus,
  PaymentStatus,
  setOrderPaymentLink,
  updateOrderStatus,
} from "./orders.service";

export const ordersRouter = Router();
ordersRouter.use(requireAuth);

// GET /api/orders/stats - Summary statistics
ordersRouter.get(
  "/stats",
  asyncHandler(async (req: AuthedRequest, res) => {
    const tenantId = req.auth!.tenantId;
    const stats = await getOrderStats(tenantId);
    res.json(stats);
  })
);

// GET /api/orders - List orders
ordersRouter.get(
  "/",
  asyncHandler(async (req: AuthedRequest, res) => {
    const tenantId = req.auth!.tenantId;
    const { status, paymentStatus, contactId, conversationId, search, limit, offset } = req.query;

    const result = await listOrders(tenantId, {
      status: status ? (String(status) as OrderStatus) : undefined,
      paymentStatus: paymentStatus ? (String(paymentStatus) as PaymentStatus) : undefined,
      contactId: typeof contactId === "string" ? contactId : undefined,
      conversationId: typeof conversationId === "string" ? conversationId : undefined,
      search: typeof search === "string" ? search : undefined,
      limit: limit ? parseInt(String(limit), 10) : 50,
      offset: offset ? parseInt(String(offset), 10) : 0,
    });

    res.json(result);
  })
);

// GET /api/orders/:id - Single order
ordersRouter.get(
  "/:id",
  asyncHandler(async (req: AuthedRequest, res) => {
    const tenantId = req.auth!.tenantId;
    const order = await getOrder(tenantId, req.params.id);
    if (!order) {
      return res.status(404).json({ error: "Order not found" });
    }
    res.json({ order });
  })
);

// POST /api/orders - Create order
ordersRouter.post(
  "/",
  asyncHandler(async (req: AuthedRequest, res) => {
    const tenantId = req.auth!.tenantId;
    const {
      contactId,
      conversationId,
      items,
      currency,
      shippingAddress,
      paymentMethod,
      metadata,
    } = req.body;

    if (!contactId || typeof contactId !== "string") {
      return res.status(400).json({ error: "contactId is required" });
    }
    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "At least one order item is required" });
    }

    const order = await createOrder(tenantId, {
      contactId,
      conversationId,
      items,
      currency,
      shippingAddress,
      paymentMethod,
      metadata,
    });

    res.status(201).json({ order });
  })
);

// PATCH /api/orders/:id/status - Update order status & payment status
ordersRouter.patch(
  "/:id/status",
  asyncHandler(async (req: AuthedRequest, res) => {
    const tenantId = req.auth!.tenantId;
    const { status, paymentStatus } = req.body;

    if (!status) {
      return res.status(400).json({ error: "status is required" });
    }

    const validStatuses: OrderStatus[] = [
      "pending",
      "paid",
      "processing",
      "shipped",
      "completed",
      "cancelled",
      "refunded",
    ];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: `Invalid order status: ${status}` });
    }

    const order = await updateOrderStatus(
      tenantId,
      req.params.id,
      status as OrderStatus,
      paymentStatus as PaymentStatus | undefined
    );

    if (!order) {
      return res.status(404).json({ error: "Order not found" });
    }

    res.json({ order });
  })
);

// POST /api/orders/:id/payment-link - Set payment link
ordersRouter.post(
  "/:id/payment-link",
  asyncHandler(async (req: AuthedRequest, res) => {
    const tenantId = req.auth!.tenantId;
    const { paymentLink, paymentMethod } = req.body;

    if (!paymentLink || typeof paymentLink !== "string") {
      return res.status(400).json({ error: "paymentLink is required" });
    }

    const order = await setOrderPaymentLink(
      tenantId,
      req.params.id,
      paymentLink,
      paymentMethod
    );

    if (!order) {
      return res.status(404).json({ error: "Order not found" });
    }

    res.json({ order });
  })
);
