const { pool } = require('./config/db');

async function run() {
  try {
    const [rows] = await pool.query('SELECT id, work_order_id, file_path, file_name FROM customer_media_uploads ORDER BY id DESC LIMIT 5;');
    console.log(rows);
  } catch (err) {
    console.error(err);
  } finally {
    process.exit(0);
  }
}

run();
