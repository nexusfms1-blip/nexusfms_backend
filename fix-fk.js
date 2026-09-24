const { pool } = require('./config/db');

async function fixFk() {
  try {
    await pool.query('ALTER TABLE notification_delivery DROP FOREIGN KEY fk_delivery_notification');
    await pool.query('ALTER TABLE notification_delivery MODIFY notification_id BIGINT NULL');
    await pool.query('ALTER TABLE notification_delivery ADD CONSTRAINT fk_delivery_notification FOREIGN KEY (notification_id) REFERENCES notifications(id) ON DELETE CASCADE');
    console.log('Fixed FK');
    process.exit(0);
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
}
fixFk();
