const { pool } = require('../config/db');

// @desc    Get all inventory items
// @route   GET /api/v1/inventory
// @access  Private (Office Admin)
const getInventoryItems = async (req, res, next) => {
  try {
    const { status, lowStock } = req.query;
    
    let sql = 'SELECT * FROM inventory_items WHERE 1=1';
    const params = [];

    if (status) {
      sql += ' AND status = ?';
      params.push(status);
    } else {
      sql += ' AND status = "ACTIVE"'; // Default to active items only
    }

    if (lowStock === 'true') {
      sql += ' AND current_quantity <= min_threshold';
    }

    sql += ' ORDER BY item_name ASC';

    const [rows] = await pool.query(sql, params);

    // Dynamic status computation for response
    const formattedRows = rows.map(item => ({
      id: item.id,
      itemName: item.item_name,
      sku: item.sku,
      description: item.description,
      category: item.category,
      currentQuantity: item.current_quantity,
      minThreshold: item.min_threshold,
      unit: item.unit,
      supplier: item.supplier,
      status: item.status,
      stockStatus: item.current_quantity <= item.min_threshold ? 'LOW STOCK' : 'NORMAL',
      createdAt: item.created_at,
      updatedAt: item.updated_at
    }));

    res.status(200).json({
      success: true,
      count: formattedRows.length,
      data: formattedRows
    });
  } catch (err) {
    next(err);
  }
};

// @desc    Get single inventory item
// @route   GET /api/v1/inventory/:id
// @access  Private (Office Admin)
const getInventoryItem = async (req, res, next) => {
  try {
    const { id } = req.params;
    const [rows] = await pool.query('SELECT * FROM inventory_items WHERE id = ?', [id]);

    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Item not found' });
    }

    const item = rows[0];
    res.status(200).json({
      success: true,
      data: {
        id: item.id,
        itemName: item.item_name,
        sku: item.sku,
        description: item.description,
        category: item.category,
        currentQuantity: item.current_quantity,
        minThreshold: item.min_threshold,
        unit: item.unit,
        supplier: item.supplier,
        status: item.status,
        stockStatus: item.current_quantity <= item.min_threshold ? 'LOW STOCK' : 'NORMAL',
      }
    });
  } catch (err) {
    next(err);
  }
};

// @desc    Create new inventory item
// @route   POST /api/v1/inventory
// @access  Private (Office Admin)
const createInventoryItem = async (req, res, next) => {
  try {
    const { itemName, sku, description, category, currentQuantity, minThreshold, unit, supplier } = req.body;

    if (!itemName) {
      return res.status(400).json({ success: false, message: 'Item name is required' });
    }

    const [result] = await pool.query(
      `INSERT INTO inventory_items (item_name, sku, description, category, current_quantity, min_threshold, unit, supplier) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [itemName, sku || null, description || null, category || null, currentQuantity || 0, minThreshold || 0, unit || 'pcs', supplier || null]
    );

    res.status(201).json({
      success: true,
      message: 'Inventory item created successfully',
      data: { id: result.insertId }
    });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ success: false, message: 'SKU must be unique' });
    }
    next(err);
  }
};

// @desc    Update inventory item
// @route   PUT /api/v1/inventory/:id
// @access  Private (Office Admin)
const updateInventoryItem = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { itemName, sku, description, category, currentQuantity, current_quantity, minThreshold, unit, supplier, status } = req.body;

    const [existing] = await pool.query('SELECT id FROM inventory_items WHERE id = ?', [id]);
    if (existing.length === 0) {
      return res.status(404).json({ success: false, message: 'Item not found' });
    }

    const finalQuantity = currentQuantity !== undefined ? currentQuantity : (current_quantity !== undefined ? current_quantity : null);

    await pool.query(
      `UPDATE inventory_items SET 
        item_name = COALESCE(?, item_name),
        sku = COALESCE(?, sku),
        description = COALESCE(?, description),
        category = COALESCE(?, category),
        current_quantity = COALESCE(?, current_quantity),
        min_threshold = COALESCE(?, min_threshold),
        unit = COALESCE(?, unit),
        supplier = COALESCE(?, supplier),
        status = COALESCE(?, status)
       WHERE id = ?`,
      [itemName, sku, description, category, finalQuantity, minThreshold, unit, supplier, status, id]
    );

    res.status(200).json({ success: true, message: 'Inventory item updated successfully' });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ success: false, message: 'SKU must be unique' });
    }
    next(err);
  }
};

// @desc    Deactivate inventory item (Soft delete)
// @route   DELETE /api/v1/inventory/:id
// @access  Private (Office Admin)
const deleteInventoryItem = async (req, res, next) => {
  try {
    const { id } = req.params;

    const [existing] = await pool.query('SELECT id FROM inventory_items WHERE id = ?', [id]);
    if (existing.length === 0) {
      return res.status(404).json({ success: false, message: 'Item not found' });
    }

    await pool.query('UPDATE inventory_items SET status = "INACTIVE" WHERE id = ?', [id]);

    res.status(200).json({ success: true, message: 'Inventory item deactivated successfully' });
  } catch (err) {
    next(err);
  }
};

// @desc    Restock inventory item atomically
// @route   POST /api/v1/inventory/:id/restock
// @access  Private (Office Admin)
const restockItem = async (req, res, next) => {
  const connection = await pool.getConnection();
  try {
    const { id } = req.params;
    const { quantity, notes } = req.body;
    const restockQty = parseInt(quantity, 10);

    if (isNaN(restockQty) || restockQty <= 0) {
      return res.status(400).json({ success: false, message: 'Restock quantity must be a positive integer' });
    }

    await connection.beginTransaction();

    // 1. SELECT ... FOR UPDATE ensures atomicity and locks the row
    const [rows] = await connection.query('SELECT current_quantity, min_threshold FROM inventory_items WHERE id = ? FOR UPDATE', [id]);
    
    if (rows.length === 0) {
      await connection.rollback();
      return res.status(404).json({ success: false, message: 'Item not found' });
    }

    const currentQty = rows[0].current_quantity;
    const minThreshold = rows[0].min_threshold;
    const newQty = currentQty + restockQty;

    // 2. Update stock
    await connection.query('UPDATE inventory_items SET current_quantity = ? WHERE id = ?', [newQty, id]);

    // 3. Record transaction history
    await connection.query(
      `INSERT INTO inventory_transactions (inventory_item_id, user_id, transaction_type, quantity_change, previous_quantity, new_quantity, notes) 
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, req.user.id, 'RESTOCK', restockQty, currentQty, newQty, notes || 'Restocked via dashboard']
    );

    await connection.commit();

    const stockStatus = newQty <= minThreshold ? 'LOW STOCK' : 'NORMAL';

    res.status(200).json({ 
      success: true, 
      message: 'Item restocked successfully',
      data: {
        id: parseInt(id, 10),
        currentQuantity: newQty,
        stockStatus
      }
    });
  } catch (err) {
    await connection.rollback();
    next(err);
  } finally {
    connection.release();
  }
};

module.exports = {
  getInventoryItems,
  getInventoryItem,
  createInventoryItem,
  updateInventoryItem,
  deleteInventoryItem,
  restockItem
};
