const mysql = require('mysql2/promise');
const dotenv = require('dotenv');

dotenv.config();

async function migratePhase7() {
  console.log('--- STARTING PHASE 7 DATABASE MIGRATION ---');
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

    // 1. Alter work_orders pipeline_stage
    console.log('Checking work_orders table...');
    const [woCols] = await connection.query("SHOW COLUMNS FROM work_orders WHERE Field = 'pipeline_stage'");
    if (woCols.length > 0) {
      const currentType = woCols[0].Type;
      if (!currentType.includes('READY_TO_QUOTE')) {
        console.log('Adding READY_TO_QUOTE to work_orders.pipeline_stage...');
        await connection.query("ALTER TABLE work_orders MODIFY COLUMN pipeline_stage ENUM('Quotes','Completed Quotes','Jobs','Completed Jobs','Jobs Waiting Booking','READY_TO_QUOTE') NOT NULL DEFAULT 'Quotes'");
        console.log('✓ work_orders pipeline_stage updated.');
      } else {
        console.log('✓ work_orders pipeline_stage already contains READY_TO_QUOTE.');
      }
    }

    // 2. Alter quote_requests status
    console.log('Checking quote_requests table...');
    const [qrCols] = await connection.query("SHOW COLUMNS FROM quote_requests WHERE Field = 'status'");
    if (qrCols.length > 0) {
      const currentType = qrCols[0].Type;
      if (!currentType.includes('COMPLETED') || !currentType.includes('PENDING')) {
        console.log('Updating quote_requests.status ENUM...');
        await connection.query("ALTER TABLE quote_requests MODIFY COLUMN status ENUM('PHOTO_REQUEST_PENDING','PENDING','SUBMITTED','COMPLETED','EXPIRED') NOT NULL DEFAULT 'PENDING'");
        console.log('✓ quote_requests status ENUM updated.');
      } else {
        console.log('✓ quote_requests status ENUM already updated.');
      }
    }

    // 3. Add reminder tracking to quote_requests
    const [allQrCols] = await connection.query("SHOW COLUMNS FROM quote_requests");
    const colNames = allQrCols.map(c => c.Field);
    
    if (!colNames.includes('last_photo_reminder_at')) {
      console.log('Adding last_photo_reminder_at to quote_requests...');
      await connection.query('ALTER TABLE quote_requests ADD COLUMN last_photo_reminder_at DATETIME NULL');
      console.log('✓ Added last_photo_reminder_at.');
    } else {
      console.log('✓ last_photo_reminder_at already exists.');
    }

    if (!colNames.includes('photo_reminder_count')) {
      console.log('Adding photo_reminder_count to quote_requests...');
      await connection.query('ALTER TABLE quote_requests ADD COLUMN photo_reminder_count INT NOT NULL DEFAULT 0');
      console.log('✓ Added photo_reminder_count.');
    } else {
      console.log('✓ photo_reminder_count already exists.');
    }

    console.log('--- MIGRATION COMPLETE ---');
  } catch (error) {
    console.error('❌ MIGRATION FAILED:', error.message);
  } finally {
    if (connection) {
      await connection.end();
    }
    process.exit(0);
  }
}

migratePhase7();
