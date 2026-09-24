const express = require('express');
const router = express.Router();
const { authenticateToken, authorizeRoles } = require('../middleware/auth.middleware');

const {
  getInventoryItems,
  getInventoryItem,
  createInventoryItem,
  updateInventoryItem,
  deleteInventoryItem,
  restockItem,
} = require('../controllers/inventory.controller');

// All inventory routes require authentication and OFFICE_ADMIN role
router.use(authenticateToken);
router.use(authorizeRoles('OFFICE_ADMIN'));

router.route('/')
  .get(getInventoryItems)
  .post(createInventoryItem);

router.route('/:id')
  .get(getInventoryItem)
  .put(updateInventoryItem)
  .delete(deleteInventoryItem);

router.route('/:id/restock')
  .post(restockItem);

module.exports = router;
