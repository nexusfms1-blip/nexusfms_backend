const { pool } = require('./config/db');

async function migratePhase10() {
  console.log('Starting Phase 10 Notification DB Migration...');

  try {
    // 1. Create notification_delivery table for tracking Email/SMS statuses
    await pool.query(`
      CREATE TABLE IF NOT EXISTS \`notification_delivery\` (
        \`id\` BIGINT AUTO_INCREMENT PRIMARY KEY,
        \`notification_id\` BIGINT NOT NULL,
        \`channel\` VARCHAR(50) NOT NULL,
        \`recipient\` VARCHAR(255) NOT NULL,
        \`status\` VARCHAR(50) NOT NULL DEFAULT 'PENDING',
        \`provider\` VARCHAR(100) DEFAULT NULL,
        \`provider_message_id\` VARCHAR(255) DEFAULT NULL,
        \`attempts\` INT NOT NULL DEFAULT 0,
        \`last_attempt_at\` TIMESTAMP NULL DEFAULT NULL,
        \`sent_at\` TIMESTAMP NULL DEFAULT NULL,
        \`failed_at\` TIMESTAMP NULL DEFAULT NULL,
        \`error_message\` TEXT DEFAULT NULL,
        \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        \`updated_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        CONSTRAINT \`fk_delivery_notification\` FOREIGN KEY (\`notification_id\`) REFERENCES \`notifications\` (\`id\`) ON DELETE CASCADE,
        INDEX \`idx_delivery_status\` (\`status\`),
        INDEX \`idx_delivery_channel\` (\`channel\`),
        INDEX \`idx_delivery_attempts\` (\`attempts\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);
    console.log('✅ Created notification_delivery table.');

    // Check if cancellation history table exists for tenants
    const [cancellationTable] = await pool.query("SHOW TABLES LIKE 'cancellation_history'");
    if (cancellationTable.length === 0) {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS \`cancellation_history\` (
            \`id\` BIGINT AUTO_INCREMENT PRIMARY KEY,
            \`work_order_id\` BIGINT NOT NULL,
            \`cancelled_by_user_id\` BIGINT NOT NULL,
            \`cancellation_type\` VARCHAR(50) NOT NULL,
            \`reason\` TEXT NOT NULL,
            \`notes\` TEXT DEFAULT NULL,
            \`proof_url\` VARCHAR(500) DEFAULT NULL,
            \`cancelled_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            CONSTRAINT \`fk_cancel_work_order\` FOREIGN KEY (\`work_order_id\`) REFERENCES \`work_orders\` (\`id\`) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
      `);
      console.log('✅ Created cancellation_history table.');
    } else {
        console.log('✅ cancellation_history table already exists.');
    }

    console.log('🎉 Phase 10 Migration Complete!');
    process.exit(0);
  } catch (error) {
    console.error('❌ Migration Failed:', error);
    process.exit(1);
  }
}

migratePhase10();
