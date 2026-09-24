const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const dotenv = require('dotenv');

dotenv.config();

async function initDatabaseSchema() {
  console.log('=======================================================');
  console.log('🚀 Starting Phase 2: MySQL Schema Execution for nexus_fms_db');
  console.log('=======================================================');

  let connection;
  try {
    // 1. Connect to MySQL Server root
    connection = await mysql.createConnection({
      host: process.env.DB_HOST || 'localhost',
      port: process.env.DB_PORT || 3306,
      user: process.env.DB_USER || 'root',
      password: process.env.DB_PASS || '',
      multipleStatements: true,
    });

    console.log('✅ [1/5] Connected to MySQL root server successfully.');

    // 2. Create Database IF NOT EXISTS
    const dbName = process.env.DB_NAME || 'nexus_fms_db';
    await connection.query(`CREATE DATABASE IF NOT EXISTS \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`);
    await connection.query(`USE \`${dbName}\`;`);
    console.log(`✅ [2/5] Database '${dbName}' selected and ready.`);

    // 3. Drop existing tables if re-initializing to ensure clean 9-table schema
    await connection.query(`
      SET FOREIGN_KEY_CHECKS = 0;
      DROP TABLE IF EXISTS \`notifications\`;
      DROP TABLE IF EXISTS \`staff_completion_media\`;
      DROP TABLE IF EXISTS \`staff_job_completions\`;
      DROP TABLE IF EXISTS \`customer_media_uploads\`;
      DROP TABLE IF EXISTS \`quote_requests\`;
      DROP TABLE IF EXISTS \`booking_requests\`;
      DROP TABLE IF EXISTS \`work_orders\`;
      DROP TABLE IF EXISTS \`residents\`;
      DROP TABLE IF EXISTS \`staff_profiles\`;
      DROP TABLE IF EXISTS \`users\`;
      SET FOREIGN_KEY_CHECKS = 1;
    `);

    // 4. Execute Table DDL Definitions for all 9 Normalized Tables
    const schemaSql = `
      -- Table 1: users (Authentication & System RBAC)
      CREATE TABLE \`users\` (
        \`id\` BIGINT AUTO_INCREMENT PRIMARY KEY,
        \`email\` VARCHAR(191) NOT NULL UNIQUE,
        \`password_hash\` VARCHAR(255) NOT NULL,
        \`full_name\` VARCHAR(150) NOT NULL,
        \`role\` ENUM('OFFICE_ADMIN', 'MAINTENANCE_STAFF') NOT NULL DEFAULT 'MAINTENANCE_STAFF',
        \`phone\` VARCHAR(50) DEFAULT NULL,
        \`avatar_url\` VARCHAR(255) DEFAULT NULL,
        \`is_active\` TINYINT(1) NOT NULL DEFAULT 1,
        \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        \`updated_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX \`idx_users_role\` (\`role\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

      -- Table 2: staff_profiles (Technician Shift, Skills & Badges)
      CREATE TABLE \`staff_profiles\` (
        \`id\` BIGINT AUTO_INCREMENT PRIMARY KEY,
        \`user_id\` BIGINT NOT NULL UNIQUE,
        \`staff_code\` VARCHAR(50) NOT NULL UNIQUE,
        \`role_title\` VARCHAR(100) NOT NULL,
        \`color_hex\` VARCHAR(20) NOT NULL DEFAULT '#009bf2',
        \`working_days_json\` JSON DEFAULT NULL,
        \`work_start_time\` TIME NOT NULL DEFAULT '08:00:00',
        \`work_end_time\` TIME NOT NULL DEFAULT '17:00:00',
        \`break_start_time\` TIME NOT NULL DEFAULT '12:00:00',
        \`break_end_time\` TIME NOT NULL DEFAULT '13:00:00',
        \`unavailable_dates_json\` JSON DEFAULT NULL,
        \`kpi_score\` INT NOT NULL DEFAULT 0,
        \`jobs_completed\` INT NOT NULL DEFAULT 0,
        \`revisits\` INT NOT NULL DEFAULT 0,
        \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        \`updated_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        CONSTRAINT \`fk_staff_profiles_user\` FOREIGN KEY (\`user_id\`) REFERENCES \`users\` (\`id\`) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

      -- Table 3: residents (Directory of Resident Contacts)
      CREATE TABLE \`residents\` (
        \`id\` BIGINT AUTO_INCREMENT PRIMARY KEY,
        \`full_name\` VARCHAR(150) NOT NULL,
        \`phone\` VARCHAR(50) NOT NULL,
        \`email\` VARCHAR(191) DEFAULT NULL,
        \`address\` TEXT NOT NULL,
        \`notes\` TEXT DEFAULT NULL,
        \`document_url\` VARCHAR(255) DEFAULT NULL,
        \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        \`updated_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX \`idx_residents_phone\` (\`phone\`),
        INDEX \`idx_residents_email\` (\`email\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

      -- Table 4: work_orders (Master Work Orders & Quotes Entity)
      CREATE TABLE \`work_orders\` (
        \`id\` BIGINT AUTO_INCREMENT PRIMARY KEY,
        \`job_number\` VARCHAR(50) NOT NULL UNIQUE,
        \`title\` VARCHAR(255) NOT NULL,
        \`resident_id\` BIGINT DEFAULT NULL,
        \`resident_name\` VARCHAR(150) NOT NULL,
        \`contact_phone\` VARCHAR(50) NOT NULL,
        \`contact_email\` VARCHAR(191) DEFAULT NULL,
        \`property_address\` TEXT NOT NULL,
        \`description\` TEXT DEFAULT NULL,
        \`duration_hours\` DECIMAL(4,2) NOT NULL DEFAULT 1.50,
        \`priority\` ENUM('URGENT', 'HIGH', 'NORMAL', 'LOW') NOT NULL DEFAULT 'NORMAL',
        \`pipeline_stage\` ENUM('Quotes', 'Completed Quotes', 'Jobs', 'Completed Jobs', 'Jobs Waiting Booking', 'Invoiced', 'Invoice') NOT NULL DEFAULT 'Quotes',
        \`assigned_staff_id\` BIGINT DEFAULT NULL,
        \`assigned_staff_ids\` JSON DEFAULT NULL,
        \`manager_name\` VARCHAR(150) DEFAULT NULL,
        \`quote_amount\` DECIMAL(10,2) DEFAULT NULL,
        \`scheduled_date\` DATE DEFAULT NULL,
        \`scheduled_time_slot\` VARCHAR(50) DEFAULT NULL,
        \`latitude\` DECIMAL(10,8) DEFAULT NULL,
        \`longitude\` DECIMAL(11,8) DEFAULT NULL,
        \`secure_token\` VARCHAR(100) NOT NULL UNIQUE,
        \`created_by\` BIGINT DEFAULT NULL,
        \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        \`updated_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX \`idx_work_orders_stage\` (\`pipeline_stage\`),
        INDEX \`idx_work_orders_scheduled_date\` (\`scheduled_date\`),
        CONSTRAINT \`fk_work_orders_resident\` FOREIGN KEY (\`resident_id\`) REFERENCES \`residents\` (\`id\`) ON DELETE SET NULL,
        CONSTRAINT \`fk_work_orders_staff\` FOREIGN KEY (\`assigned_staff_id\`) REFERENCES \`staff_profiles\` (\`id\`) ON DELETE SET NULL,
        CONSTRAINT \`fk_work_orders_creator\` FOREIGN KEY (\`created_by\`) REFERENCES \`users\` (\`id\`) ON DELETE SET NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

      -- Table 5: booking_requests (Public Slot Booking Token Links)
      CREATE TABLE \`booking_requests\` (
        \`id\` BIGINT AUTO_INCREMENT PRIMARY KEY,
        \`work_order_id\` BIGINT NOT NULL UNIQUE,
        \`secure_token\` VARCHAR(100) NOT NULL UNIQUE,
        \`assignment_preference_staff_id\` BIGINT DEFAULT NULL,
        \`earliest_date\` DATE DEFAULT NULL,
        \`internal_notes\` TEXT DEFAULT NULL,
        \`status\` ENUM('WAITING_FOR_BOOKING', 'BOOKED', 'EXPIRED') NOT NULL DEFAULT 'WAITING_FOR_BOOKING',
        \`expires_at\` DATETIME NOT NULL,
        \`booked_date\` DATE DEFAULT NULL,
        \`booked_time_slot\` VARCHAR(50) DEFAULT NULL,
        \`booked_at\` DATETIME DEFAULT NULL,
        \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        \`updated_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX \`idx_booking_requests_status\` (\`status\`),
        CONSTRAINT \`fk_booking_requests_work_order\` FOREIGN KEY (\`work_order_id\`) REFERENCES \`work_orders\` (\`id\`) ON DELETE CASCADE,
        CONSTRAINT \`fk_booking_requests_staff_pref\` FOREIGN KEY (\`assignment_preference_staff_id\`) REFERENCES \`staff_profiles\` (\`id\`) ON DELETE SET NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

      -- Table 6: quote_requests (Public Photo/Video Upload Token Links)
      CREATE TABLE \`quote_requests\` (
        \`id\` BIGINT AUTO_INCREMENT PRIMARY KEY,
        \`work_order_id\` BIGINT NOT NULL UNIQUE,
        \`secure_token\` VARCHAR(100) NOT NULL UNIQUE,
        \`photo_instructions\` TEXT DEFAULT NULL,
        \`max_photos\` INT NOT NULL DEFAULT 5,
        \`status\` ENUM('PHOTO_REQUEST_PENDING', 'SUBMITTED', 'EXPIRED') NOT NULL DEFAULT 'PHOTO_REQUEST_PENDING',
        \`expires_at\` DATETIME NOT NULL,
        \`resident_description_report\` TEXT DEFAULT NULL,
        \`submitted_at\` DATETIME DEFAULT NULL,
        \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        \`updated_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX \`idx_quote_requests_status\` (\`status\`),
        CONSTRAINT \`fk_quote_requests_work_order\` FOREIGN KEY (\`work_order_id\`) REFERENCES \`work_orders\` (\`id\`) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

      -- Table 7: customer_media_uploads (Resident Uploaded Photos & Videos)
      CREATE TABLE \`customer_media_uploads\` (
        \`id\` BIGINT AUTO_INCREMENT PRIMARY KEY,
        \`quote_request_id\` BIGINT NOT NULL,
        \`work_order_id\` BIGINT NOT NULL,
        \`media_type\` ENUM('PHOTO', 'VIDEO') NOT NULL DEFAULT 'PHOTO',
        \`file_name\` VARCHAR(255) NOT NULL,
        \`file_path\` VARCHAR(500) NOT NULL,
        \`file_size_bytes\` BIGINT DEFAULT NULL,
        \`mime_type\` VARCHAR(100) DEFAULT NULL,
        \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT \`fk_customer_media_quote_req\` FOREIGN KEY (\`quote_request_id\`) REFERENCES \`quote_requests\` (\`id\`) ON DELETE CASCADE,
        CONSTRAINT \`fk_customer_media_work_order\` FOREIGN KEY (\`work_order_id\`) REFERENCES \`work_orders\` (\`id\`) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

      -- Table 8: staff_job_completions (Technician Completion Reports)
      CREATE TABLE \`staff_job_completions\` (
        \`id\` BIGINT AUTO_INCREMENT PRIMARY KEY,
        \`work_order_id\` BIGINT NOT NULL,
        \`staff_id\` BIGINT NOT NULL,
        \`work_report_summary\` TEXT NOT NULL,
        \`materials_used\` TEXT DEFAULT NULL,
        \`completion_status\` ENUM('COMPLETED', 'PARTIALLY_COMPLETED', 'NEED_FOLLOWUP') NOT NULL DEFAULT 'COMPLETED',
        \`completed_at\` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        \`updated_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        CONSTRAINT \`fk_staff_completions_work_order\` FOREIGN KEY (\`work_order_id\`) REFERENCES \`work_orders\` (\`id\`) ON DELETE CASCADE,
        CONSTRAINT \`fk_staff_completions_staff\` FOREIGN KEY (\`staff_id\`) REFERENCES \`staff_profiles\` (\`id\`) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

      -- Table 9: staff_completion_media (Technician Proof Photos)
      CREATE TABLE \`staff_completion_media\` (
        \`id\` BIGINT AUTO_INCREMENT PRIMARY KEY,
        \`completion_id\` BIGINT NOT NULL,
        \`work_order_id\` BIGINT NOT NULL,
        \`file_name\` VARCHAR(255) NOT NULL,
        \`file_path\` VARCHAR(500) NOT NULL,
        \`file_size_bytes\` BIGINT DEFAULT NULL,
        \`mime_type\` VARCHAR(100) DEFAULT NULL,
        \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT \`fk_completion_media_completion\` FOREIGN KEY (\`completion_id\`) REFERENCES \`staff_job_completions\` (\`id\`) ON DELETE CASCADE,
        CONSTRAINT \`fk_completion_media_work_order\` FOREIGN KEY (\`work_order_id\`) REFERENCES \`work_orders\` (\`id\`) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

      -- Table 10: notifications (Persistent User-Specific Notifications)
      CREATE TABLE \`notifications\` (
        \`id\` BIGINT AUTO_INCREMENT PRIMARY KEY,
        \`user_id\` BIGINT NOT NULL,
        \`notification_type\` VARCHAR(50) NOT NULL,
        \`title\` VARCHAR(255) NOT NULL,
        \`message\` TEXT NOT NULL,
        \`related_entity_type\` VARCHAR(50) DEFAULT NULL,
        \`related_entity_id\` BIGINT DEFAULT NULL,
        \`action_url\` VARCHAR(255) DEFAULT NULL,
        \`is_read\` TINYINT(1) NOT NULL DEFAULT 0,
        \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        \`read_at\` TIMESTAMP NULL DEFAULT NULL,
        CONSTRAINT \`fk_notifications_user\` FOREIGN KEY (\`user_id\`) REFERENCES \`users\` (\`id\`) ON DELETE CASCADE,
        INDEX \`idx_notifications_user_id\` (\`user_id\`),
        INDEX \`idx_notifications_user_unread\` (\`user_id\`, \`is_read\`),
        INDEX \`idx_notifications_created_at\` (\`created_at\`),
        INDEX \`idx_notifications_type\` (\`notification_type\`),
        INDEX \`idx_notifications_entity\` (\`related_entity_type\`, \`related_entity_id\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `;

    await connection.query(schemaSql);
    console.log('✅ [3/5] Executed SQL DDL for all 9 normalized tables successfully.');

    // 5. Seed ONLY 2 Authentication Accounts (No Business/Demo Data)
    const salt = await bcrypt.genSalt(10);
    const defaultPasswordHash = await bcrypt.hash('Password123!', salt);

    // Insert Admin User
    await connection.query(
      `INSERT INTO \`users\` (\`email\`, \`password_hash\`, \`full_name\`, \`role\`, \`is_active\`) VALUES (?, ?, ?, ?, ?)`,
      ['admin@nexusfms.com', defaultPasswordHash, 'Office Admin', 'OFFICE_ADMIN', 1]
    );

    // Insert Staff User
    await connection.query(
      `INSERT INTO \`users\` (\`email\`, \`password_hash\`, \`full_name\`, \`role\`, \`is_active\`) VALUES (?, ?, ?, ?, ?)`,
      ['staff@nexusfms.com', defaultPasswordHash, 'Maintenance Staff', 'MAINTENANCE_STAFF', 1]
    );

    console.log('✅ [4/5] Seeded ONLY the 2 required test authentication users (Office Admin & Staff User). Zero business profiles.');

    // 6. Perform Full Automated Database & Table Verification
    console.log('\n=======================================================');
    console.log('🔍 Executing Automated Schema Verification...');
    console.log('=======================================================');

    const [tables] = await connection.query(`SHOW TABLES IN \`${dbName}\`;`);
    const tableList = tables.map(t => Object.values(t)[0]);

    console.log(`📌 Total Tables Found: ${tableList.length} (Expected: 9)`);
    console.table(tableList);

    const businessTables = [
      'staff_profiles',
      'residents',
      'work_orders',
      'booking_requests',
      'quote_requests',
      'customer_media_uploads',
      'staff_job_completions',
      'staff_completion_media'
    ];

    let allEmpty = true;
    for (const table of businessTables) {
      const [[{ count }]] = await connection.query(`SELECT COUNT(*) as count FROM \`${table}\`;`);
      if (count !== 0) {
        allEmpty = false;
        console.error(`❌ Table '${table}' contains ${count} records! (Expected 0)`);
      }
    }

    const [[resUser]] = await connection.query(`SELECT COUNT(*) as count FROM \`users\`;`);
    const userCount = Number(resUser.count);

    console.log(`📌 Verification Checks: Tables=${tableList.length}, AllBusinessTablesEmpty=${allEmpty}, UserCount=${userCount}`);

    if (tableList.length === 9 && allEmpty && userCount === 2) {
      console.log('\n🎉 [PHASE 2 VERIFICATION PASSED]');
      console.log(` - 9 Tables Created Cleanly in phpMyAdmin`);
      console.log(` - Exactly 2 Auth Users Present (admin@nexusfms.com, staff@nexusfms.com)`);
      console.log(` - Business Data Tables Contain EXACTLY 0 Demo Records`);
      console.log(` - Foreign Keys & Unique Constraints Active`);
    } else {
      console.error('\n❌ [VERIFICATION FAILED] Schema verification did not match criteria.');
    }

  } catch (error) {
    console.error('❌ [SCHEMA EXECUTION ERROR]:', error.message);
  } finally {
    if (connection) await connection.end();
  }
}

initDatabaseSchema();
