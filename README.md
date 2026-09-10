# Omni-platform backend

Omnichannel chatbot / CRM / business-automation backend. Node.js + TypeScript + Express, talking to Postgres directly through `pg` — no ORM. See `IMPLEMENTATION_TRACKER.md` for what's built vs planned, and `omnichannel-platform-architecture.md` (in the parent conversation) for the full system design.

## Guides & Documentation

- [Architecture Plan](../omnichannel-platform-architecture.md)
- [Implementation Tracker](../IMPLEMENTATION_TRACKER.md)
- [Testing & Operation Guide (Flows, Commerce, WhatsApp Catalogs & Payments)](../TESTING_AND_OPERATION_GUIDE.md)
- [Production Deployment Guide](../PRODUCTION_DEPLOYMENT_GUIDE.md)

```bash
cp .env.example .env
docker compose up -d
npm install
npm run migrate
npm run dev
```

API runs on `http://localhost:4000`. See `IMPLEMENTATION_TRACKER.md` for a smoke-test walkthrough.

## Project layout

```
migrations/            plain .sql migration files, applied in filename order
src/
  db/                   connection pool, transaction helper, migration runner
  middleware/           auth (JWT verification, role checks)
  modules/
    auth/               signup, login
    channels/           channel CRUD + the ChannelAdapter interface/registry
      adapters/          one file per channel (whatsapp.adapter.ts, ...)
    contacts/           find-or-create contacts per channel
    conversations/       conversation lifecycle, agent assignment
    messages/            inbound persistence, outbound send
    webhooks/            inbound webhook receivers per channel
  index.ts              Express app wiring
```

Adding a new channel = implement `ChannelAdapter`, register it in `channel-registry.ts`, add a webhook route. Nothing else changes.
