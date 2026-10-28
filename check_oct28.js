const { pool } = require('./config/db');

async function test() {
  const [rows] = await pool.query(
    'SELECT id, job_number, title, assigned_staff_id, scheduled_date, scheduled_time_slot, duration_hours FROM work_orders WHERE scheduled_date = "2026-10-28"'
  );
  console.log(JSON.stringify(rows, null, 2));
  process.exit(0);
}

test().catch(err => {
  console.error(err);
  process.exit(1);
});

