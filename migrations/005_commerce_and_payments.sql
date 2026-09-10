-- 005_commerce_and_payments.sql
-- Commerce, WhatsApp Catalogs, Orders & Payment Gateways

-- ─────────────────────────────────────────────────────────────
-- Products Catalog
-- ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS products (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  sku             TEXT NOT NULL,
  description     TEXT,
  price           NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
  currency        TEXT NOT NULL DEFAULT 'INR',
  category        TEXT,
  images          JSONB NOT NULL DEFAULT '[]', -- Array of image URLs / storage keys
  stock_quantity  INTEGER NOT NULL DEFAULT 0,
  is_available    BOOLEAN NOT NULL DEFAULT true,
  metadata        JSONB NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, sku)
);

CREATE INDEX IF NOT EXISTS products_tenant_idx ON products (tenant_id);
CREATE INDEX IF NOT EXISTS products_category_idx ON products (tenant_id, category);
CREATE INDEX IF NOT EXISTS products_available_idx ON products (tenant_id, is_available);

-- ─────────────────────────────────────────────────────────────
-- Orders & Cart Lifecycle
-- ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS orders (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  contact_id        UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  conversation_id   UUID REFERENCES conversations(id) ON DELETE SET NULL,
  order_number      TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'processing', 'shipped', 'completed', 'cancelled', 'refunded')),
  currency          TEXT NOT NULL DEFAULT 'INR',
  total_amount      NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
  items             JSONB NOT NULL DEFAULT '[]', -- Array of { productId, sku, name, quantity, unitPrice, total }
  shipping_address  JSONB,
  payment_status    TEXT NOT NULL DEFAULT 'pending' CHECK (payment_status IN ('pending', 'authorized', 'captured', 'failed', 'refunded')),
  payment_method    TEXT, -- 'razorpay' | 'stripe' | 'whatsapp_pay' | 'cod' | 'manual'
  payment_link      TEXT,
  metadata          JSONB NOT NULL DEFAULT '{}',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, order_number)
);

CREATE INDEX IF NOT EXISTS orders_tenant_idx ON orders (tenant_id);
CREATE INDEX IF NOT EXISTS orders_contact_idx ON orders (contact_id);
CREATE INDEX IF NOT EXISTS orders_status_idx ON orders (tenant_id, status);
CREATE INDEX IF NOT EXISTS orders_created_idx ON orders (tenant_id, created_at DESC);

-- ─────────────────────────────────────────────────────────────
-- Payment Transactions Audit
-- ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS payment_transactions (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  order_id            UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  gateway             TEXT NOT NULL CHECK (gateway IN ('razorpay', 'stripe', 'whatsapp_pay', 'manual')),
  gateway_order_id    TEXT,
  gateway_payment_id  TEXT,
  amount              NUMERIC(12, 2) NOT NULL,
  currency            TEXT NOT NULL DEFAULT 'INR',
  status              TEXT NOT NULL DEFAULT 'created' CHECK (status IN ('created', 'success', 'failed', 'refunded')),
  raw_response        JSONB NOT NULL DEFAULT '{}',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS payment_transactions_tenant_idx ON payment_transactions (tenant_id);
CREATE INDEX IF NOT EXISTS payment_transactions_order_idx ON payment_transactions (order_id);
CREATE INDEX IF NOT EXISTS payment_transactions_gateway_idx ON payment_transactions (gateway_payment_id);
