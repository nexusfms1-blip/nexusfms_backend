const { pool } = require('./db');

/**
 * Ensures critical database schema updates are applied safely and idempotently.
 * This runs automatically on server start without disturbing existing data.
 */
const runAutoMigrations = async () => {
  try {
    console.log('🔄 [Auto-Migration] Checking and applying database schema migrations...');

    // 1. Ensure work_orders.pipeline_stage supports all stages including 'Invoiced' and 'Invoice'
    // Converting ENUM to VARCHAR(100) prevents MySQL Error 1265 ("Data truncated for column 'pipeline_stage'")
    // while keeping all existing values and indexes completely intact.
    try {
      await pool.query("ALTER TABLE work_orders MODIFY COLUMN pipeline_stage VARCHAR(100) NOT NULL DEFAULT 'Quotes'");
      console.log('  ✓ [Auto-Migration] work_orders.pipeline_stage ensured as VARCHAR(100)');
    } catch (err) {
      console.warn('  ⚠️ [Auto-Migration] Could not modify work_orders.pipeline_stage:', err.message);
    }

    // 2. Ensure job_material_costs table exists
    try {
      await pool.query(`
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
          inventory_item_id BIGINT DEFAULT NULL,
          INDEX idx_jmc_wo (work_order_id),
          INDEX idx_jmc_tech (technician_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
      `);
      console.log('  ✓ [Auto-Migration] job_material_costs table verified');
    } catch (err) {
      console.warn('  ⚠️ [Auto-Migration] Could not verify job_material_costs table:', err.message);
    }

    // 3. Ensure users table role ENUM includes OFFICE_TEAM
    try {
      await pool.query("ALTER TABLE users MODIFY COLUMN role ENUM('OFFICE_ADMIN', 'OFFICE_TEAM', 'MAINTENANCE_STAFF') NOT NULL DEFAULT 'MAINTENANCE_STAFF'");
      console.log('  ✓ [Auto-Migration] users.role ENUM verified');
    } catch (err) {
      console.warn('  ⚠️ [Auto-Migration] Could not verify users.role:', err.message);
    }

    // 4. Ensure work_orders table has all required columns safely
    const optionalColumns = [
      { name: 'priority', ddl: "ALTER TABLE work_orders ADD COLUMN priority ENUM('URGENT', 'HIGH', 'NORMAL', 'LOW') NOT NULL DEFAULT 'NORMAL'" },
      { name: 'latitude', ddl: "ALTER TABLE work_orders ADD COLUMN latitude DECIMAL(10,8) DEFAULT NULL" },
      { name: 'longitude', ddl: "ALTER TABLE work_orders ADD COLUMN longitude DECIMAL(11,8) DEFAULT NULL" },
      { name: 'assigned_staff_ids', ddl: "ALTER TABLE work_orders ADD COLUMN assigned_staff_ids JSON DEFAULT NULL" },
      { name: 'manager_email', ddl: "ALTER TABLE work_orders ADD COLUMN manager_email VARCHAR(191) DEFAULT NULL" },
      { name: 'cancellation_type', ddl: "ALTER TABLE work_orders ADD COLUMN cancellation_type ENUM('TENANT_CANCELLED', 'TECHNICIAN_CANCELLED') DEFAULT NULL" },
      { name: 'cancellation_reason', ddl: "ALTER TABLE work_orders ADD COLUMN cancellation_reason TEXT DEFAULT NULL" },
      { name: 'cancelled_by', ddl: "ALTER TABLE work_orders ADD COLUMN cancelled_by BIGINT DEFAULT NULL" },
      { name: 'cancelled_at', ddl: "ALTER TABLE work_orders ADD COLUMN cancelled_at TIMESTAMP NULL DEFAULT NULL" },
      { name: 'previous_appointment_date', ddl: "ALTER TABLE work_orders ADD COLUMN previous_appointment_date DATE DEFAULT NULL" },
      { name: 'previous_appointment_time', ddl: "ALTER TABLE work_orders ADD COLUMN previous_appointment_time VARCHAR(50) DEFAULT NULL" },
      { name: 'detected_category', ddl: "ALTER TABLE work_orders ADD COLUMN detected_category VARCHAR(100) DEFAULT NULL" },
      { name: 'external_reference_id', ddl: "ALTER TABLE work_orders ADD COLUMN external_reference_id VARCHAR(255) DEFAULT NULL" },
      { name: 'original_sender_email', ddl: "ALTER TABLE work_orders ADD COLUMN original_sender_email VARCHAR(191) DEFAULT NULL" }
    ];

    for (const col of optionalColumns) {
      try {
        await pool.query(col.ddl);
      } catch (colErr) {
        if (colErr.code !== 'ER_DUP_FIELDNAME') {
          // Field already exists or non-critical error
        }
      }
    }

    // Ensure unique index on external_reference_id and index on original_sender_email
    try {
      await pool.query("ALTER TABLE work_orders ADD UNIQUE INDEX uq_wo_external_reference (external_reference_id)");
    } catch (idxErr) {
      // Ignored if already exists
    }
    try {
      await pool.query("ALTER TABLE work_orders ADD INDEX idx_wo_original_sender (original_sender_email)");
    } catch (idxErr) {
      // Ignored if already exists
    }

    // Ensure customer_media_uploads.quote_request_id allows NULL
    try {
      await pool.query("ALTER TABLE customer_media_uploads MODIFY COLUMN quote_request_id BIGINT NULL");
    } catch (cmErr) {
      // Ignored if already nullable
    }

    // 5. Ensure staff_profiles table has trade & workload management columns
    const staffColumns = [
      { name: 'trades_json', ddl: "ALTER TABLE staff_profiles ADD COLUMN trades_json JSON DEFAULT NULL" },
      { name: 'max_active_jobs', ddl: "ALTER TABLE staff_profiles ADD COLUMN max_active_jobs INT NOT NULL DEFAULT 5" }
    ];

    for (const col of staffColumns) {
      try {
        await pool.query(col.ddl);
      } catch (colErr) {
        if (colErr.code !== 'ER_DUP_FIELDNAME') {
          // Field already exists or non-critical error
        }
      }
    }

    // 6. Ensure job_assignment_logs audit table exists
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS job_assignment_logs (
          id BIGINT AUTO_INCREMENT PRIMARY KEY,
          work_order_id BIGINT NOT NULL,
          staff_id BIGINT NOT NULL,
          assigned_by VARCHAR(100) NOT NULL DEFAULT 'SYSTEM_AUTO_ASSIGN',
          assignment_type ENUM('AUTO_SKILL_MATCH', 'MANUAL_ADMIN', 'REASSIGNMENT') NOT NULL DEFAULT 'AUTO_SKILL_MATCH',
          trade_category VARCHAR(100) DEFAULT NULL,
          match_score INT NOT NULL DEFAULT 0,
          selection_reason TEXT NOT NULL,
          assigned_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          INDEX idx_jal_wo (work_order_id),
          INDEX idx_jal_staff (staff_id),
          CONSTRAINT fk_jal_wo FOREIGN KEY (work_order_id) REFERENCES work_orders (id) ON DELETE CASCADE,
          CONSTRAINT fk_jal_staff FOREIGN KEY (staff_id) REFERENCES staff_profiles (id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
      `);
      console.log('  ✓ [Auto-Migration] job_assignment_logs table verified');
    } catch (err) {
      console.warn('  ⚠️ [Auto-Migration] Could not verify job_assignment_logs table:', err.message);
    }

    console.log('✅ [Auto-Migration] Auto-migrations completed successfully.');
  } catch (error) {
    console.error('❌ [Auto-Migration Error]:', error.message);
  }
};

module.exports = { runAutoMigrations };
