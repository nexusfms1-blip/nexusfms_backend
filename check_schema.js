const { pool } = require('./config/db');
(async () => {
  try {
    const [cols] = await pool.query("SHOW COLUMNS FROM work_orders WHERE Field = 'pipeline_stage'");
    console.log(cols);
  } catch(e) {
    console.error(e);
  }
  process.exit(0);
})();
