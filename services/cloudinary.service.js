const cloudinary = require('cloudinary').v2;
const fs = require('fs');
const { pool } = require('../config/db');

/**
 * Cloudinary Media Service for Nexus FMS
 *
 * Dynamically handles photo and video uploads to Cloudinary CDN.
 * Reads credentials from `system_settings` (with fallback to .env).
 * If Cloudinary is disabled, unconfigured, or encounters network errors,
 * it seamlessly falls back to local server storage (/uploads/) without
 * interrupting the user or failing uploads.
 */

let cachedConfig = null;
let lastCacheTime = 0;
const CACHE_TTL_MS = 15000; // 15 seconds cache

/**
 * Invalidate cached Cloudinary credentials (called on settings update)
 */
const clearConfigCache = () => {
  cachedConfig = null;
  lastCacheTime = 0;
};

/**
 * Load active Cloudinary configuration from DB or process.env
 */
const getCloudinaryConfig = async () => {
  const now = Date.now();
  if (cachedConfig && now - lastCacheTime < CACHE_TTL_MS) {
    return cachedConfig;
  }

  let cloudName = process.env.CLOUDINARY_CLOUD_NAME || '';
  let apiKey = process.env.CLOUDINARY_API_KEY || '';
  let apiSecret = process.env.CLOUDINARY_API_SECRET || '';
  let isEnabled = true;

  try {
    const [rows] = await pool.query(
      'SELECT settings_json FROM system_settings ORDER BY id DESC LIMIT 1'
    );
    if (rows.length > 0) {
      let settings = rows[0].settings_json;
      if (typeof settings === 'string') {
        try {
          settings = JSON.parse(settings);
        } catch {
          settings = {};
        }
      }

      if (settings.cloudinaryCloudName !== undefined) cloudName = (settings.cloudinaryCloudName || '').trim();
      if (settings.cloudinaryApiKey !== undefined) apiKey = (settings.cloudinaryApiKey || '').trim();
      if (settings.cloudinaryApiSecret !== undefined) apiSecret = (settings.cloudinaryApiSecret || '').trim();
      if (settings.cloudinaryEnabled !== undefined) isEnabled = Boolean(settings.cloudinaryEnabled);
    }
  } catch (dbErr) {
    console.warn('[CloudinaryService] Could not read system_settings, using env fallback:', dbErr.message);
  }

  const hasCredentials = Boolean(cloudName && apiKey && apiSecret);
  const active = isEnabled && hasCredentials;

  cachedConfig = {
    active,
    isEnabled,
    hasCredentials,
    cloudName,
    apiKey,
    apiSecret,
  };
  lastCacheTime = now;

  return cachedConfig;
};

/**
 * Uploads a Multer file to Cloudinary with automatic fallback to local disk.
 *
 * @param {object} file - Express/Multer file object (path, filename, mimetype, etc.)
 * @param {string} subfolder - Subfolder under 'nexus_fms' (e.g. 'quotes', 'completion', 'avatars')
 * @returns {Promise<{ url: string, provider: 'CLOUDINARY'|'LOCAL', publicId?: string, error?: string }>}
 */
const uploadMediaFile = async (file, subfolder = 'general') => {
  if (!file) return null;

  const localUrl = `/uploads/${file.filename}`;
  const config = await getCloudinaryConfig();

  if (!config.active) {
    // Cloudinary is not configured or disabled -> keep local file
    return {
      url: localUrl,
      provider: 'LOCAL',
    };
  }

  try {
    cloudinary.config({
      cloud_name: config.cloudName,
      api_key: config.apiKey,
      api_secret: config.apiSecret,
      secure: true,
    });

    const isVideo = file.mimetype && file.mimetype.startsWith('video');
    const resourceType = isVideo ? 'video' : 'auto';

    const result = await cloudinary.uploader.upload(file.path, {
      folder: `nexus_fms/${subfolder}`,
      resource_type: resourceType,
      use_filename: true,
      unique_filename: true,
    });

    // Clean up local temp disk file after successful Cloudinary upload
    if (file.path && fs.existsSync(file.path)) {
      fs.unlink(file.path, (unlinkErr) => {
        if (unlinkErr) {
          console.warn('[CloudinaryService] Temp file cleanup warning:', unlinkErr.message);
        }
      });
    }

    console.log(`[CloudinaryService] ✓ Uploaded ${file.filename} to Cloudinary: ${result.secure_url}`);

    return {
      url: result.secure_url,
      provider: 'CLOUDINARY',
      publicId: result.public_id,
    };
  } catch (err) {
    console.warn(`[CloudinaryService] ⚠ Cloudinary upload failed for ${file.filename}. Falling back to local storage:`, err.message);
    // Graceful fallback: the file remains on disk at file.path, so localUrl is valid!
    return {
      url: localUrl,
      provider: 'LOCAL',
      error: err.message,
    };
  }
};

/**
 * Tests Cloudinary API connection with given credentials.
 *
 * @param {object} credentials - { cloudName, apiKey, apiSecret }
 * @returns {Promise<{ success: boolean, message?: string, error?: string }>}
 */
const testCloudinaryConnection = async ({ cloudName, apiKey, apiSecret }) => {
  const cName = (cloudName || '').trim();
  const aKey = (apiKey || '').trim();
  const aSec = (apiSecret || '').trim();

  if (!cName || !aKey || !aSec) {
    return {
      success: false,
      error: 'Cloud Name, API Key, and API Secret are all required to test connection.',
    };
  }

  try {
    cloudinary.config({
      cloud_name: cName,
      api_key: aKey,
      api_secret: aSec,
      secure: true,
    });

    const res = await cloudinary.api.ping();
    return {
      success: true,
      status: res.status || 'ok',
      message: 'Cloudinary credentials verified successfully! Cloud storage is ready.',
    };
  } catch (err) {
    return {
      success: false,
      error: err.message || 'Failed to authenticate with Cloudinary. Please verify your credentials.',
    };
  }
};

module.exports = {
  getCloudinaryConfig,
  clearConfigCache,
  uploadMediaFile,
  testCloudinaryConnection,
};
