const mysql = require('mysql2/promise');
const dotenv = require('dotenv');

dotenv.config();

async function createWorkOrderTemplatesTable() {
  console.log('--- STARTING STEP 1: CREATE work_order_templates TABLE ON LIVE RAILWAY DB ---');
  let connection;

  try {
    connection = await mysql.createConnection({
      host: process.env.DB_HOST || 'shinkansen.proxy.rlwy.net',
      port: process.env.DB_PORT || 35342,
      user: process.env.DB_USER || 'root',
      password: process.env.DB_PASS,
      database: process.env.DB_NAME || 'railway',
    });

    console.log('✓ Successfully connected to Live Railway MySQL Database.');

    // 1. Create work_order_templates table
    const createTableQuery = `
      CREATE TABLE IF NOT EXISTS work_order_templates (
        id INT AUTO_INCREMENT PRIMARY KEY,
        client_name VARCHAR(150) NOT NULL,
        client_code VARCHAR(50) DEFAULT NULL,
        sender_email_domain VARCHAR(150) DEFAULT NULL,
        sample_file_url VARCHAR(255) DEFAULT NULL,
        sample_file_name VARCHAR(255) DEFAULT NULL,
        mapping_rules JSON DEFAULT NULL,
        ai_prompt_instructions TEXT DEFAULT NULL,
        default_pipeline_stage ENUM('Quotes', 'Completed Quotes', 'Jobs Waiting Booking', 'Jobs') DEFAULT 'Jobs Waiting Booking',
        total_processed_count INT DEFAULT 0,
        last_used_at DATETIME DEFAULT NULL,
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_client_name (client_name),
        INDEX idx_email_domain (sender_email_domain)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `;

    await connection.query(createTableQuery);
    console.log('✓ work_order_templates table created or verified successfully.');

    // 2. Check if work_orders has template_id or source_type
    const [cols] = await connection.query("SHOW COLUMNS FROM work_orders LIKE 'source_type'");
    if (cols.length === 0) {
      console.log('Adding source_type column to work_orders...');
      await connection.query("ALTER TABLE work_orders ADD COLUMN source_type VARCHAR(50) DEFAULT 'MANUAL'");
      console.log('✓ source_type added to work_orders.');
    } else {
      console.log('✓ work_orders.source_type already exists.');
    }

    const [tplCols] = await connection.query("SHOW COLUMNS FROM work_orders LIKE 'template_id'");
    if (tplCols.length === 0) {
      console.log('Adding template_id column to work_orders...');
      await connection.query("ALTER TABLE work_orders ADD COLUMN template_id INT NULL DEFAULT NULL");
      console.log('✓ template_id added to work_orders.');
    } else {
      console.log('✓ work_orders.template_id already exists.');
    }

    // 3. Describe the new work_order_templates table to verify
    const [tableDesc] = await connection.query("DESCRIBE work_order_templates");
    console.log('\n--- VERIFIED work_order_templates COLUMNS ---');
    console.table(tableDesc.map(c => ({ Field: c.Field, Type: c.Type, Null: c.Null, Key: c.Key })));

    console.log('\n✓ STEP 1: DATABASE MIGRATION COMPLETE SUCCESSFULLY!');
  } catch (error) {
    console.error('❌ MIGRATION FAILED:', error);
  } finally {
    if (connection) {
      await connection.end();
    }
    process.exit(0);
  }
}

createWorkOrderTemplatesTable();
