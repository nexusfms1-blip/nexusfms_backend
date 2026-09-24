const mysql = require('mysql2/promise');
const dotenv = require('dotenv');

dotenv.config();

async function createInventoryTables() {
  console.log('=======================================================');
  console.log('📦 Starting Inventory Tables Creation for nexus_fms_db');
  console.log('=======================================================');

  let connection;
  try {
    connection = await mysql.createConnection({
      host: process.env.DB_HOST || 'localhost',
      port: process.env.DB_PORT || 3306,
      user: process.env.DB_USER || 'root',
      password: process.env.DB_PASS || '',
      database: process.env.DB_NAME || 'nexus_fms_db',
      multipleStatements: true,
    });

    console.log('✅ Connected to MySQL database successfully.');

    const sql = `
      CREATE TABLE IF NOT EXISTS \`inventory_items\` (
        \`id\` BIGINT AUTO_INCREMENT PRIMARY KEY,
        \`item_name\` VARCHAR(150) NOT NULL,
        \`sku\` VARCHAR(50) DEFAULT NULL UNIQUE,
        \`description\` TEXT DEFAULT NULL,
        \`category\` VARCHAR(100) DEFAULT NULL,
        \`current_quantity\` INT NOT NULL DEFAULT 0,
        \`min_threshold\` INT NOT NULL DEFAULT 0,
        \`unit\` VARCHAR(20) NOT NULL DEFAULT 'pcs',
        \`supplier\` VARCHAR(150) DEFAULT NULL,
        \`status\` ENUM('ACTIVE', 'INACTIVE') NOT NULL DEFAULT 'ACTIVE',
        \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        \`updated_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX \`idx_inventory_items_status\` (\`status\`),
        INDEX \`idx_inventory_items_category\` (\`category\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

      CREATE TABLE IF NOT EXISTS \`inventory_transactions\` (
        \`id\` BIGINT AUTO_INCREMENT PRIMARY KEY,
        \`inventory_item_id\` BIGINT NOT NULL,
        \`user_id\` BIGINT NOT NULL,
        \`transaction_type\` ENUM('RESTOCK', 'MANUAL_ADJUST', 'CONSUMED') NOT NULL,
        \`quantity_change\` INT NOT NULL,
        \`previous_quantity\` INT NOT NULL,
        \`new_quantity\` INT NOT NULL,
        \`notes\` TEXT DEFAULT NULL,
        \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT \`fk_inv_trans_item\` FOREIGN KEY (\`inventory_item_id\`) REFERENCES \`inventory_items\` (\`id\`) ON DELETE CASCADE,
        CONSTRAINT \`fk_inv_trans_user\` FOREIGN KEY (\`user_id\`) REFERENCES \`users\` (\`id\`) ON DELETE CASCADE,
        INDEX \`idx_inv_trans_item_id\` (\`inventory_item_id\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `;

    await connection.query(sql);
    console.log('✅ Inventory tables created successfully.');

  } catch (error) {
    console.error('❌ [SCHEMA EXECUTION ERROR]:', error.message);
  } finally {
    if (connection) await connection.end();
  }
}

createInventoryTables();
