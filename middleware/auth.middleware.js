const jwt = require('jsonwebtoken');
const { pool } = require('../config/db');

// Verify JWT Token Middleware
const authenticateToken = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        success: false,
        message: 'Access denied. No authentication token provided.',
      });
    }

    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'nexus_fms_jwt_secret_key_2026_super_secure');

    // Fetch user from DB to ensure account is active and valid
    const [rows] = await pool.query(
      'SELECT id, email, full_name, role, phone, avatar_url, is_active FROM users WHERE id = ?',
      [decoded.id]
    );

    if (rows.length === 0 || !rows[0].is_active) {
      return res.status(401).json({
        success: false,
        message: 'Unauthorized. User account not found or deactivated.',
      });
    }

    req.user = rows[0];

    // If user is a maintenance staff, fetch their staff profile ID
    if (req.user.role === 'MAINTENANCE_STAFF') {
      const [profileRows] = await pool.query(
        'SELECT id FROM staff_profiles WHERE user_id = ? LIMIT 1',
        [req.user.id]
      );
      if (profileRows.length > 0) {
        req.user.staffProfileId = profileRows[0].id;
      }
    }

    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({
        success: false,
        message: 'Token has expired. Please login again.',
      });
    }
    return res.status(401).json({
      success: false,
      message: 'Invalid authentication token.',
    });
  }
};

// Role Authorization Middleware
const authorizeRoles = (...allowedRoles) => {
  return (req, res, next) => {
    if (!req.user || !allowedRoles.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: `Forbidden. Role '${req.user ? req.user.role : 'UNKNOWN'}' is not authorized to access this resource. Required roles: ${allowedRoles.join(', ')}`,
      });
    }
    next();
  };
};

module.exports = {
  authenticateToken,
  authorizeRoles,
};
