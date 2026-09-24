const { pool } = require('./config/db');

async function runMigration() {
  console.log('Starting Phase 11 Migration (Manager Email column)...');
  try {
    const connection = await pool.getConnection();

    // Add manager_email to work_orders
    try {
      await connection.query(`
        ALTER TABLE work_orders 
        ADD COLUMN manager_email VARCHAR(191) DEFAULT NULL;
      `);
      console.log('✅ Added manager_email column to work_orders table');
    } catch (err) {
      if (err.code === 'ER_DUP_COLUMNNAME' || err.message.includes('Multiple columns') || err.message.includes('Duplicate column name')) {
        console.log('⚠️ manager_email column already exists in work_orders, skipping...');
      } else {
        throw err;
      }
    }

    connection.release();
    console.log('✅ Phase 11 Migration completed successfully!');
    process.exit(0);
  } catch (error) {
    console.error('❌ Migration Failed:', error);
    process.exit(1);
  }
}

runMigration();
