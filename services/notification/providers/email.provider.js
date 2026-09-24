/**
 * Mock Email Provider for Development
 * In production, this would wrap Nodemailer, SendGrid, SES, etc.
 */

const sendEmail = async ({ to, subject, body }) => {
  console.log(`[EMAIL_PROVIDER] ✉️ Sending Email to ${to}`);
  console.log(`[EMAIL_PROVIDER] Subject: ${subject}`);
  
  // Simulate network delay
  await new Promise(resolve => setTimeout(resolve, 500));

  // In development, we always pretend it succeeded unless explicitly forced to fail
  // We can simulate a random failure for testing retries if an environment variable is set
  if (process.env.SIMULATE_PROVIDER_FAILURES === 'true' && Math.random() < 0.2) {
    throw new Error('DEVELOPMENT_PROVIDER_SIMULATED_FAILURE');
  }

  const messageId = `dev-email-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  return {
    success: true,
    provider: 'DEVELOPMENT_EMAIL_PROVIDER',
    messageId,
  };
};

module.exports = { sendEmail };
