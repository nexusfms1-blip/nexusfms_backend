const { pool } = require('./config/db');

async function updateDb() {
  try {
    console.log('Altering users table to add OFFICE_TEAM role...');
    await pool.query("ALTER TABLE users MODIFY COLUMN role ENUM('OFFICE_ADMIN', 'OFFICE_TEAM', 'MAINTENANCE_STAFF') NOT NULL DEFAULT 'MAINTENANCE_STAFF'");
    console.log('Successfully updated users.role ENUM.');
    process.exit(0);
  } catch (error) {
    console.error('Failed to update DB:', error);
    process.exit(1);
  }
}

updateDb();
