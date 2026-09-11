const { Pool } = require('pg');
require('dotenv').config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function searchAll() {
  const ids = ['a1fc6cd8-5dee-40f4-abf3-fe5ef0babc4d', 'a34ba8f9-9d57-483a-ac27-76719095381f'];
  console.log('Searching for IDs:', ids);

  const tablesRes = await pool.query(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
  `);

  for (const tRow of tablesRes.rows) {
    const table = tRow.table_name;
    const colsRes = await pool.query(`
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_name = $1
    `, [table]);

    for (const cRow of colsRes.rows) {
      for (const id of ids) {
        try {
          const sql = `SELECT * FROM "${table}" WHERE "${cRow.column_name}"::text LIKE $1`;
          const res = await pool.query(sql, [`%${id}%`]);
          if (res.rows.length > 0) {
            console.log(`\n>>> MATCH FOUND in table: ${table}, column: ${cRow.column_name}`);
            console.log(JSON.stringify(res.rows, null, 2));
          }
        } catch (err) {
          // ignore column casting errors
        }
      }
    }
  }

  // Also check system logs in memory/logger
  console.log('\nSearch completed.');
  await pool.end();
}

searchAll().catch(console.error);
