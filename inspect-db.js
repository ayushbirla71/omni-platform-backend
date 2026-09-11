const { Pool } = require('pg');
require('dotenv').config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function inspectDb() {
  console.log('--- Channels ---');
  const channels = await pool.query('SELECT id, type, display_name, tenant_id, default_flow_id FROM channels');
  console.log(channels.rows);

  console.log('--- Flows ---');
  const flows = await pool.query('SELECT id, name, tenant_id, status, deleted_at FROM flows');
  console.log(flows.rows);

  console.log('--- Campaigns ---');
  const campaigns = await pool.query('SELECT id, name, tenant_id, channel_id, type, status FROM campaigns');
  console.log(campaigns.rows);

  console.log('--- Conversations ---');
  const convs = await pool.query('SELECT id, tenant_id, channel_id, contact_id, status FROM conversations LIMIT 5');
  console.log(convs.rows);

  console.log('--- Contacts ---');
  const contacts = await pool.query('SELECT id, tenant_id, name, external_id FROM contacts LIMIT 5');
  console.log(contacts.rows);

  console.log('--- Tenants ---');
  const tenants = await pool.query('SELECT id, name FROM tenants');
  console.log(tenants.rows);

  await pool.end();
}

inspectDb().catch(console.error);
