require('dotenv').config();
const { pool } = require('./config/db');

async function migratePhase6() {
  console.log("Starting Phase 6 Database Migration: Technician Job Completion...");

  let connection;
  try {
    connection = await pool.getConnection();

    // 1. Add media_type to staff_completion_media
    console.log("Checking staff_completion_media for media_type column...");
    try {
      await connection.query("ALTER TABLE staff_completion_media ADD COLUMN media_type ENUM('BEFORE', 'AFTER', 'RECEIPT', 'OTHER') DEFAULT 'OTHER'");
      console.log("✅ Added media_type to staff_completion_media.");
    } catch (err) {
      if (err.code === 'ER_DUP_FIELDNAME') {
        console.log("ℹ️ media_type column already exists in staff_completion_media.");
        // Try to update ENUM definition just in case 'RECEIPT' is missing
        try {
          await connection.query("ALTER TABLE staff_completion_media MODIFY COLUMN media_type ENUM('BEFORE', 'AFTER', 'RECEIPT', 'OTHER') DEFAULT 'OTHER'");
        } catch (e) {}
      } else {
        throw err;
      }
    }

    // 2. Create job_material_costs table
    console.log("Creating job_material_costs table...");
    await connection.query(`
      CREATE TABLE IF NOT EXISTS job_material_costs (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        work_order_id BIGINT NOT NULL,
        technician_id BIGINT NOT NULL,
        material_name VARCHAR(255) NOT NULL,
        quantity DECIMAL(10,2) NOT NULL,
        unit_cost DECIMAL(10,2) NOT NULL,
        total_cost DECIMAL(10,2) NOT NULL,
        receipt_path VARCHAR(500) NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (work_order_id) REFERENCES work_orders(id) ON DELETE CASCADE,
        FOREIGN KEY (technician_id) REFERENCES staff_profiles(id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);
    console.log("✅ job_material_costs table ready.");

    console.log("🎉 Phase 6 Migration completed successfully.");
  } catch (err) {
    console.error("❌ Phase 6 Migration failed:", err);
    process.exit(1);
  } finally {
    if (connection) connection.release();
    process.exit(0);
  }
}

migratePhase6();
