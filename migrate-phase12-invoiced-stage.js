const mysql = require('mysql2/promise');
const dotenv = require('dotenv');

dotenv.config();

async function migratePhase12() {
  console.log('--- STARTING PHASE 12: ADD "INVOICED" PIPELINE STAGE ---');
  let connection;

  try {
    connection = await mysql.createConnection({
      host: process.env.DB_HOST || 'localhost',
      port: process.env.DB_PORT || 3306,
      user: process.env.DB_USER || 'root',
      password: process.env.DB_PASS || '',
      database: process.env.DB_NAME || 'nexus_fms_db',
    });

    console.log('✓ Connected to database.');

    // 1. Alter work_orders pipeline_stage ENUM to include 'Invoiced' and 'Invoice'
    console.log('Checking work_orders table pipeline_stage column...');
    const [woCols] = await connection.query("SHOW COLUMNS FROM work_orders WHERE Field = 'pipeline_stage'");
    if (woCols.length > 0) {
      const currentType = woCols[0].Type;
      if (!currentType.includes('Invoiced')) {
        console.log('Adding Invoiced to work_orders.pipeline_stage...');
        await connection.query("ALTER TABLE work_orders MODIFY COLUMN pipeline_stage ENUM('Quotes','Completed Quotes','Jobs','Completed Jobs','Jobs Waiting Booking','READY_TO_QUOTE','Invoiced','Invoice') NOT NULL DEFAULT 'Quotes'");
        console.log('✓ work_orders pipeline_stage updated to support Invoiced.');
      } else {
        console.log('✓ work_orders pipeline_stage already contains Invoiced.');
      }
    }

    console.log('--- PHASE 12 MIGRATION COMPLETE ---');
  } catch (error) {
    console.error('❌ MIGRATION FAILED:', error.message);
  } finally {
    if (connection) {
      await connection.end();
    }
    process.exit(0);
  }
}

migratePhase12();
