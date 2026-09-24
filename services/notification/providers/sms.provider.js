/**
 * SMS Provider for Nexus FMS
 * Supports:
 * 1. Twilio Live SMS (Pay-as-you-go ~3.5p/SMS)
 * 2. N8N Webhook SMS (Free automation / WhatsApp / SMS gateway)
 * 3. Development Mock Simulator (Zero external dependencies)
 */

const { normalizePhoneNumber } = require('../../../utils/phoneNormalizer');

const sendSms = async ({ to, message }) => {
  const normalizedTo = normalizePhoneNumber(to);
  const twilioSid = process.env.TWILIO_ACCOUNT_SID;
  const twilioAuthToken = process.env.TWILIO_AUTH_TOKEN;
  const twilioFromPhone = process.env.TWILIO_PHONE_NUMBER;
  const n8nSmsWebhookUrl = process.env.N8N_SMS_WEBHOOK_URL;

  // ── Mode 1: Live Twilio Integration ────────────────────────────────────────
  if (twilioSid && twilioAuthToken && twilioFromPhone) {
    try {
      console.log(`[TWILIO_SMS] 📱 Dispatching live SMS to ${normalizedTo}...`);
      const twilioUrl = `https://api.twilio.com/2010-04-01/Accounts/${twilioSid}/Messages.json`;
      
      const authHeader = 'Basic ' + Buffer.from(`${twilioSid}:${twilioAuthToken}`).toString('base64');
      const params = new URLSearchParams();
      params.append('To', normalizedTo);
      params.append('From', twilioFromPhone);
      params.append('Body', message);

      const response = await fetch(twilioUrl, {
        method: 'POST',
        headers: {
          'Authorization': authHeader,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: params.toString(),
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.message || `Twilio Error HTTP ${response.status}`);
      }

      console.log(`[TWILIO_SMS] ✓ SMS sent successfully (SID: ${data.sid})`);
      return {
        success: true,
        provider: 'TWILIO',
        messageId: data.sid,
      };
    } catch (err) {
      console.error(`[TWILIO_SMS_ERROR] ❌ Failed to send SMS via Twilio:`, err.message);
      throw err;
    }
  }

  // ── Mode 2: Live N8N SMS / WhatsApp Webhook ────────────────────────────────
  if (n8nSmsWebhookUrl) {
    try {
      console.log(`[N8N_SMS] 📱 Forwarding SMS trigger to N8N webhook...`);
      const response = await fetch(n8nSmsWebhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: normalizedTo, message, timestamp: new Date().toISOString() }),
      });
      const data = await response.json().catch(() => ({}));
      return {
        success: true,
        provider: 'N8N_SMS_GATEWAY',
        messageId: `n8n-${Date.now()}`,
        data,
      };
    } catch (err) {
      console.error(`[N8N_SMS_ERROR] ❌ Failed to send SMS via N8N:`, err.message);
      throw err;
    }
  }

  // ── Mode 3: Development Simulator ──────────────────────────────────────────
  console.log(`[SMS_DEV_SIMULATOR] 📱 Simulated SMS to ${normalizedTo}`);
  console.log(`[SMS_DEV_SIMULATOR] Content: ${message}`);
  
  await new Promise(resolve => setTimeout(resolve, 300));

  const messageId = `dev-sms-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  return {
    success: true,
    provider: 'DEVELOPMENT_SMS_SIMULATOR',
    messageId,
  };
};

module.exports = { sendSms };
