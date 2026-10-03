const mysql = require('mysql2/promise');
require('dotenv').config();
async function run(){
  try {
    const pool = mysql.createPool({
      host: process.env.DB_HOST,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME
    });
    const [rows] = await pool.query('DESCRIBE quote_requests');
    const statusRow = rows.find(r => r.Field === 'status');
    console.log(statusRow.Type);
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}
run();
