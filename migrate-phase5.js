const mysql = require('mysql2/promise');

async function migrateDatabase() {
  const connection = await mysql.createConnection({
    host: 'hayabusa.proxy.rlwy.net',
    port: 37923,
    user: 'root',
    password: 'KNDOGiJCCQYRBgHLpYTSnCUWKZUddvHO',
    database: 'railway'
  });

  try {
    console.log("Beginning DB Migration for Phase 5...");

    // 1. Alter work_orders (ignore errors if columns exist)
    console.log("Altering work_orders...");
    const cols = [
      "ADD COLUMN cancellation_type ENUM('TENANT_CANCELLED', 'TECHNICIAN_CANCELLED') NULL",
      "ADD COLUMN cancellation_reason TEXT NULL",
      "ADD COLUMN cancelled_by BIGINT NULL",
      "ADD COLUMN cancelled_at TIMESTAMP NULL",
      "ADD COLUMN previous_appointment_date DATE NULL",
      "ADD COLUMN previous_appointment_time VARCHAR(50) NULL"
    ];
    for (const col of cols) {
      try {
        await connection.query(`ALTER TABLE work_orders ${col};`);
        console.log(`Successfully executed: ${col}`);
      } catch (err) {
        if (err.code === 'ER_DUP_FIELDNAME') {
          console.log(`Skipping (already exists): ${col}`);
        } else {
          throw err;
        }
      }
    }

    // 2. Create appointment_history
    console.log("Creating appointment_history...");
    await connection.query(`
      CREATE TABLE IF NOT EXISTS appointment_history (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        work_order_id BIGINT NOT NULL,
        action_type VARCHAR(50) NOT NULL,
        previous_date DATE NULL,
        previous_time VARCHAR(50) NULL,
        new_date DATE NULL,
        new_time VARCHAR(50) NULL,
        cancellation_type VARCHAR(50) NULL,
        reason TEXT NULL,
        performed_by BIGINT NULL,
        performed_by_role VARCHAR(50) NULL,
        notes TEXT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_work_order_id (work_order_id),
        FOREIGN KEY (work_order_id) REFERENCES work_orders(id) ON DELETE CASCADE
      );
    `);

    // 3. Create cancellation_media_uploads
    console.log("Creating cancellation_media_uploads...");
    await connection.query(`
      CREATE TABLE IF NOT EXISTS cancellation_media_uploads (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        work_order_id BIGINT NOT NULL,
        appointment_history_id BIGINT NULL,
        file_name VARCHAR(255) NOT NULL,
        file_path VARCHAR(500) NOT NULL,
        mime_type VARCHAR(100) NULL,
        file_size_bytes BIGINT NULL,
        uploaded_by BIGINT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (work_order_id) REFERENCES work_orders(id) ON DELETE CASCADE,
        FOREIGN KEY (appointment_history_id) REFERENCES appointment_history(id) ON DELETE SET NULL
      );
    `);

    console.log("✅ Migration completed successfully!");

  } catch (err) {
    console.error("❌ Migration failed:", err);
  } finally {
    await connection.end();
  }
}

migrateDatabase();
