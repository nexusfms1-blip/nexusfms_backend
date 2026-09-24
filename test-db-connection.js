const mysql = require('mysql2/promise');
const dotenv = require('dotenv');

dotenv.config();

async function testConnection() {
  console.log('=======================================================');
  console.log('🔍 Testing MySQL Connection for Nexus FMS...');
  console.log(`📌 Target Host: ${process.env.DB_HOST}:${process.env.DB_PORT}`);
  console.log(`📌 Target User: ${process.env.DB_USER}`);
  console.log(`📌 Target Database: ${process.env.DB_NAME}`);
  console.log('=======================================================');

  try {
    // 1. Test server connection
    const connection = await mysql.createConnection({
      host: process.env.DB_HOST || 'localhost',
      port: process.env.DB_PORT || 3306,
      user: process.env.DB_USER || 'root',
      password: process.env.DB_PASS || '',
    });

    console.log('✅ [SUCCESS] MySQL Server is UP and responding!');

    // 2. Ensure database exists
    await connection.query(`CREATE DATABASE IF NOT EXISTS \`${process.env.DB_NAME || 'nexus_fms_db'}\`;`);
    console.log(`✅ [SUCCESS] Database '${process.env.DB_NAME}' exists and is ready!`);

    await connection.end();

    // 3. Test pool connection to the specific database
    const pool = mysql.createPool({
      host: process.env.DB_HOST || 'localhost',
      port: process.env.DB_PORT || 3306,
      user: process.env.DB_USER || 'root',
      password: process.env.DB_PASS || '',
      database: process.env.DB_NAME || 'nexus_fms_db',
    });

    const poolConn = await pool.getConnection();
    console.log(`🎉 [VERIFIED] Backend successfully connected to '${process.env.DB_NAME}' database via MySQL!`);
    poolConn.release();
    process.exit(0);

  } catch (error) {
    console.error('❌ [CONNECTION FAILED] Could not connect to MySQL:');
    console.error(`   Error Code: ${error.code || 'UNKNOWN'}`);
    console.error(`   Message: ${error.message}`);
    console.log('\n💡 Troubleshooting Steps:');
    console.log('   1. Start MySQL service (XAMPP Control Panel or Services.msc -> Start "MySQL80").');
    console.log('   2. Verify DB_PASS in Backend/.env if your root user has a password.');
    process.exit(1);
  }
}

testConnection();
