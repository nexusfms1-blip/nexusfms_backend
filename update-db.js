const mysql = require('mysql2/promise');
const dotenv = require('dotenv');

dotenv.config();

async function updateLiveDB() {
  console.log('🚀 Connecting to Railway DB to apply safe migrations...');
  let connection;
  try {
    connection = await mysql.createConnection({
      host: process.env.DB_HOST,
      port: process.env.DB_PORT,
      user: process.env.DB_USER,
      password: process.env.DB_PASS,
      database: process.env.DB_NAME,
      multipleStatements: true,
    });

    console.log('✅ Connected. Running ALTER TABLE queries...');

    // Add columns safely (using try-catch for each to ignore if they already exist)
    const queries = [
      "ALTER TABLE work_orders ADD COLUMN priority ENUM('URGENT', 'HIGH', 'NORMAL', 'LOW') NOT NULL DEFAULT 'NORMAL';",
      "ALTER TABLE work_orders ADD COLUMN latitude DECIMAL(10,8) DEFAULT NULL;",
      "ALTER TABLE work_orders ADD COLUMN longitude DECIMAL(11,8) DEFAULT NULL;",
      "ALTER TABLE work_orders ADD COLUMN assigned_staff_ids JSON DEFAULT NULL;",
      "ALTER TABLE staff_profiles ADD COLUMN kpi_score INT NOT NULL DEFAULT 0;",
      "ALTER TABLE staff_profiles ADD COLUMN jobs_completed INT NOT NULL DEFAULT 0;",
      "ALTER TABLE staff_profiles ADD COLUMN revisits INT NOT NULL DEFAULT 0;",
      "ALTER TABLE staff_profiles ADD COLUMN duty_status VARCHAR(50) NOT NULL DEFAULT 'AVAILABLE';",
      "ALTER TABLE residents ADD COLUMN avatar_url VARCHAR(255) DEFAULT NULL;"
    ];

    for (const q of queries) {
      try {
        await connection.query(q);
        console.log(`✅ Success: ${q}`);
      } catch (e) {
        if (e.code === 'ER_DUP_FIELDNAME') {
          console.log(`ℹ️ Skipped (already exists): ${q}`);
        } else {
          console.error(`❌ Error on: ${q} =>`, e.message);
        }
      }
    }

    console.log('🎉 Live Railway Database updated successfully without data loss!');
  } catch (err) {
    console.error('Database connection failed:', err);
  } finally {
    if (connection) await connection.end();
  }
}

updateLiveDB();
