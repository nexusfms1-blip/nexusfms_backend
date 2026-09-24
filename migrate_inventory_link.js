const { pool } = require('./config/db');

async function migrate() {
  const conn = await pool.getConnection();
  try {
    // Add inventory_item_id to job_material_costs if missing
    const [cols] = await conn.query("SHOW COLUMNS FROM job_material_costs LIKE 'inventory_item_id'");
    if (cols.length === 0) {
      await conn.query('ALTER TABLE job_material_costs ADD COLUMN inventory_item_id INT NULL DEFAULT NULL, ADD INDEX idx_jmc_inv_item (inventory_item_id)');
      console.log('✓ Added inventory_item_id to job_material_costs');
    } else {
      console.log('✓ inventory_item_id already exists in job_material_costs');
    }

    // Ensure inventory_transactions has previous_quantity + new_quantity
    const [itCols] = await conn.query("SHOW COLUMNS FROM inventory_transactions LIKE 'previous_quantity'");
    if (itCols.length === 0) {
      await conn.query('ALTER TABLE inventory_transactions ADD COLUMN previous_quantity DECIMAL(10,2) NULL AFTER quantity_change, ADD COLUMN new_quantity DECIMAL(10,2) NULL AFTER previous_quantity');
      console.log('✓ Added previous_quantity, new_quantity to inventory_transactions');
    } else {
      console.log('✓ previous_quantity already exists in inventory_transactions');
    }

    console.log('Migration complete.');
  } catch (err) {
    console.error('Migration error:', err.message);
  } finally {
    conn.release();
    process.exit(0);
  }
}

migrate();
