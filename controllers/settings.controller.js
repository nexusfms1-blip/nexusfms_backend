const { pool } = require('../config/db');
const { testCloudinaryConnection, clearConfigCache } = require('../services/cloudinary.service');

// @desc    Get system settings
// @route   GET /api/v1/settings
// @access  Private
const getSettings = async (req, res, next) => {
  try {
    const [rows] = await pool.query('SELECT settings_json FROM system_settings ORDER BY id DESC LIMIT 1');
    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Settings not found' });
    }
    let settingsData = rows[0].settings_json;
    if (typeof settingsData === 'string') {
      try {
        settingsData = JSON.parse(settingsData);
      } catch (e) {
        console.error('Failed to parse settings JSON', e);
      }
    }
    res.status(200).json({ success: true, data: settingsData });
  } catch (err) {
    next(err);
  }
};

// @desc    Update system settings
// @route   PUT /api/v1/settings
// @access  Private (Admin only conceptually, though currently just Private)
const updateSettings = async (req, res, next) => {
  try {
    const newSettings = req.body;
    
    // We update the existing row since there's only one active settings row
    await pool.query('UPDATE system_settings SET settings_json = ? ORDER BY id DESC LIMIT 1', [JSON.stringify(newSettings)]);
    
    // Invalidate cached Cloudinary config so changes take effect immediately
    clearConfigCache();

    res.status(200).json({ success: true, message: 'Settings updated successfully', data: newSettings });
  } catch (err) {
    next(err);
  }
};

// @desc    Test Cloudinary credentials
// @route   POST /api/v1/settings/test-cloudinary
// @access  Private (Office Admin)
const testCloudinary = async (req, res, next) => {
  try {
    const { cloudName, apiKey, apiSecret } = req.body;
    const result = await testCloudinaryConnection({ cloudName, apiKey, apiSecret });
    if (!result.success) {
      return res.status(400).json(result);
    }
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
};

module.exports = {
  getSettings,
  updateSettings,
  testCloudinary,
};
