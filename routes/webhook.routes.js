const express = require('express');
const router = express.Router();
const webhookController = require('../controllers/webhook.controller');

// Simple middleware to enforce API key security for webhooks
const requireWebhookApiKey = (req, res, next) => {
  const apiKey = req.headers['x-api-key'];
  const expectedKey = process.env.WEBHOOK_SECRET_KEY;

  if (!expectedKey) {
    console.error('[Webhook Auth Error] WEBHOOK_SECRET_KEY is not defined in backend environment.');
    return res.status(500).json({ success: false, message: 'Server configuration error.' });
  }

  if (!apiKey || apiKey !== expectedKey) {
    return res.status(401).json({
      success: false,
      message: 'Unauthorized. Invalid or missing x-api-key.',
    });
  }

  next();
};

// Route for external email-to-quote automation
router.post('/quotes', requireWebhookApiKey, webhookController.handleIncomingEmailQuote);

module.exports = router;
