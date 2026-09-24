const mysql = require('mysql2/promise');
const dotenv = require('dotenv');

dotenv.config();

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASS || '',
  database: process.env.DB_NAME || 'nexus_fms_db',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  enableKeepAlive: true,
  keepAliveInitialDelay: 10000,
});

// Test database connection helper
const testDbConnection = async () => {
  try {
    const connection = await pool.getConnection();
    console.log(`[MySQL Connection] Successfully connected to database '${process.env.DB_NAME || 'nexus_fms_db'}' on ${process.env.DB_HOST || 'localhost'}:${process.env.DB_PORT || 3306}`);
    connection.release();
    return true;
  } catch (error) {
    console.warn(`[MySQL Connection Warning] Database connection test failed: ${error.message}. Ensure MySQL service is running in phpMyAdmin/XAMPP.`);
    return false;
  }
};

module.exports = {
  pool,
  testDbConnection,
};
