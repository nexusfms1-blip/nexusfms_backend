const express = require('express');
const router = express.Router();
const { authenticateToken, authorizeRoles } = require('../middleware/auth.middleware');
const { getSettings, updateSettings, testCloudinary } = require('../controllers/settings.controller');

router.use(authenticateToken);
router.use(authorizeRoles('OFFICE_ADMIN'));

router.get('/', getSettings);
router.put('/', updateSettings);
router.post('/test-cloudinary', testCloudinary);

module.exports = router;
