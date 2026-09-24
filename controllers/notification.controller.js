const { pool } = require('../config/db');

// @desc    Get user notifications and unread count
// @route   GET /api/v1/notifications
// @access  Private (JWT Required)
const getNotifications = async (req, res, next) => {
  try {
    const userId = req.user.id;

    // Fetch latest 20 notifications for the user
    const [rows] = await pool.query(
      `SELECT id, notification_type as type, title, message, related_entity_type as relatedEntityType, 
              related_entity_id as relatedEntityId, action_url as actionUrl, is_read as isRead, 
              created_at as createdAt, read_at as readAt
       FROM notifications
       WHERE user_id = ?
       ORDER BY created_at DESC
       LIMIT 20`,
      [userId]
    );

    // Calculate unread count from DB
    const [countRows] = await pool.query(
      'SELECT COUNT(*) as unreadCount FROM notifications WHERE user_id = ? AND is_read = 0',
      [userId]
    );

    res.status(200).json({
      success: true,
      unreadCount: countRows[0].unreadCount,
      data: rows
    });
  } catch (err) {
    next(err);
  }
};

// @desc    Mark a notification as read
// @route   PUT /api/v1/notifications/:id/read
// @access  Private (JWT Required)
const markAsRead = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const { id } = req.params;

    // Validate ownership
    const [rows] = await pool.query('SELECT user_id FROM notifications WHERE id = ?', [id]);
    if (rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Notification not found.'
      });
    }

    if (rows[0].user_id !== userId) {
      return res.status(403).json({
        success: false,
        message: 'Forbidden. You do not own this notification.'
      });
    }

    await pool.query(
      'UPDATE notifications SET is_read = 1, read_at = NOW() WHERE id = ?',
      [id]
    );

    res.status(200).json({
      success: true,
      message: 'Notification marked as read successfully.'
    });
  } catch (err) {
    next(err);
  }
};

// @desc    Mark all user notifications as read
// @route   PUT /api/v1/notifications/read-all
// @access  Private (JWT Required)
const markAllAsRead = async (req, res, next) => {
  try {
    const userId = req.user.id;

    await pool.query(
      'UPDATE notifications SET is_read = 1, read_at = NOW() WHERE user_id = ? AND is_read = 0',
      [userId]
    );

    res.status(200).json({
      success: true,
      message: 'All notifications marked as read.'
    });
  } catch (err) {
    next(err);
  }
};

module.exports = {
  getNotifications,
  markAsRead,
  markAllAsRead
};
