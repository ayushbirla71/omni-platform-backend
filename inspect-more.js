const { Pool } = require('pg');
require('dotenv').config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function inspectMore() {
  const ids = ['a1fc6cd8-5dee-40f4-abf3-fe5ef0babc4d', 'a34ba8f9-9d57-483a-ac27-76719095381f'];

  const tables = await pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'");
  console.log('Tables in DB:', tables.rows.map(r => r.table_name).join(', '));

  const users = await pool.query('SELECT id, email, name, role, tenant_id FROM users');
  console.log('Users:', users.rows);

  const kb = await pool.query('SELECT id, name, tenant_id FROM knowledge_bases');
  console.log('Knowledge Bases:', kb.rows);

  await pool.end();
}
inspectMore().catch(console.error);
