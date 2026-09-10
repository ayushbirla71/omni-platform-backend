import { Router } from "express";
import { AuthedRequest, requireAuth } from "../../middleware/auth";
import { asyncHandler } from "../../middleware/async-handler";
import {
  createProduct,
  deleteProduct,
  getProduct,
  getProductCategories,
  listProducts,
  updateProduct,
} from "./products.service";

export const productsRouter = Router();
productsRouter.use(requireAuth);

// GET /api/products - List products with optional search, category, and isAvailable filters
productsRouter.get(
  "/",
  asyncHandler(async (req: AuthedRequest, res) => {
    const tenantId = req.auth!.tenantId;
    const { search, category, isAvailable, limit, offset } = req.query;

    const parsedAvailable =
      isAvailable === "true" ? true : isAvailable === "false" ? false : undefined;

    const result = await listProducts(tenantId, {
      search: typeof search === "string" ? search : undefined,
      category: typeof category === "string" ? category : undefined,
      isAvailable: parsedAvailable,
      limit: limit ? parseInt(String(limit), 10) : 50,
      offset: offset ? parseInt(String(offset), 10) : 0,
    });

    res.json(result);
  })
);

// GET /api/products/categories - Distinct categories for tenant
productsRouter.get(
  "/categories",
  asyncHandler(async (req: AuthedRequest, res) => {
    const tenantId = req.auth!.tenantId;
    const categories = await getProductCategories(tenantId);
    res.json({ categories });
  })
);

// GET /api/products/:id - Single product
productsRouter.get(
  "/:id",
  asyncHandler(async (req: AuthedRequest, res) => {
    const tenantId = req.auth!.tenantId;
    const product = await getProduct(tenantId, req.params.id);
    if (!product) {
      return res.status(404).json({ error: "Product not found" });
    }
    res.json({ product });
  })
);

// POST /api/products - Create a new product
productsRouter.post(
  "/",
  asyncHandler(async (req: AuthedRequest, res) => {
    const tenantId = req.auth!.tenantId;
    const {
      name,
      sku,
      description,
      price,
      currency,
      category,
      images,
      stockQuantity,
      isAvailable,
      metadata,
    } = req.body;

    if (!name || typeof name !== "string" || !name.trim()) {
      return res.status(400).json({ error: "Product name is required" });
    }
    if (!sku || typeof sku !== "string" || !sku.trim()) {
      return res.status(400).json({ error: "Product SKU is required" });
    }
    if (price === undefined || typeof price !== "number" || isNaN(price) || price < 0) {
      return res.status(400).json({ error: "Valid price is required (>= 0)" });
    }

    const product = await createProduct(tenantId, {
      name,
      sku,
      description,
      price,
      currency,
      category,
      images,
      stockQuantity,
      isAvailable,
      metadata,
    });

    res.status(201).json({ product });
  })
);

// PATCH /api/products/:id - Update product
productsRouter.patch(
  "/:id",
  asyncHandler(async (req: AuthedRequest, res) => {
    const tenantId = req.auth!.tenantId;
    const product = await updateProduct(tenantId, req.params.id, req.body);
    if (!product) {
      return res.status(404).json({ error: "Product not found" });
    }
    res.json({ product });
  })
);

// DELETE /api/products/:id - Delete product
productsRouter.delete(
  "/:id",
  asyncHandler(async (req: AuthedRequest, res) => {
    const tenantId = req.auth!.tenantId;
    const deleted = await deleteProduct(tenantId, req.params.id);
    if (!deleted) {
      return res.status(404).json({ error: "Product not found" });
    }
    res.json({ success: true });
  })
);
