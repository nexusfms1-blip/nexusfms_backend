const mysql = require('mysql2/promise');

async function inspectSchema() {
  const connection = await mysql.createConnection({
    host: 'hayabusa.proxy.rlwy.net',
    port: 37923,
    user: 'root',
    password: 'KNDOGiJCCQYRBgHLpYTSnCUWKZUddvHO',
    database: 'railway'
  });

  try {
    const [workOrders] = await connection.query("DESCRIBE work_orders;");
    console.log("=== work_orders ===");
    console.table(workOrders);

    const [tables] = await connection.query("SHOW TABLES;");
    console.log("=== Tables ===");
    console.log(tables.map(t => Object.values(t)[0]));

    const [media] = await connection.query("DESCRIBE staff_completion_media;");
    console.log("=== staff_completion_media ===");
    console.table(media);
  } catch (err) {
    console.error(err);
  } finally {
    await connection.end();
  }
}

inspectSchema();
