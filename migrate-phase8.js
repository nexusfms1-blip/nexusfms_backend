const { pool } = require('./config/db');

async function runMigration() {
  console.log('Starting Phase 8 Migration...');
  try {
    const connection = await pool.getConnection();

    // Add last_reminder_at to booking_requests
    try {
      await connection.query(`
        ALTER TABLE booking_requests 
        ADD COLUMN last_reminder_at DATETIME NULL DEFAULT NULL,
        ADD COLUMN reminder_count INT NOT NULL DEFAULT 0;
      `);
      console.log('✅ Added reminder columns to booking_requests');
    } catch (err) {
      if (err.code === 'ER_DUP_FIELDNAME') {
        console.log('⚠️ Reminder columns already exist in booking_requests, skipping...');
      } else {
        throw err;
      }
    }

    // Ensure status includes CANCELLED
    try {
      await connection.query(`
        ALTER TABLE booking_requests 
        MODIFY COLUMN status ENUM('WAITING_FOR_BOOKING','BOOKED','EXPIRED','CANCELLED') NOT NULL DEFAULT 'WAITING_FOR_BOOKING';
      `);
      console.log('✅ Updated status enum in booking_requests to include CANCELLED');
    } catch (err) {
      console.log('⚠️ Could not update status enum or it already exists:', err.message);
    }

    connection.release();
    console.log('✅ Phase 8 Migration completed successfully!');
    process.exit(0);
  } catch (error) {
    console.error('❌ Migration Failed:', error);
    process.exit(1);
  }
}

runMigration();
