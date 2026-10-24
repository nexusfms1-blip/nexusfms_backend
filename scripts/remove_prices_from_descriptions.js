const fs = require('fs');
const { pool } = require('../config/db');

function cleanDescription(desc) {
  if (!desc) return desc;

  let cleaned = desc;

  // 1. Cut off at divider line if present (e.g. ----------------------------------------)
  if (/---+|===+|___+/.test(cleaned)) {
    cleaned = cleaned.split(/---+|===+|___+/)[0].trim();
  }

  // 2. Remove price lines like '120 + VAT', '£150', '340 + vat', '95 + VAT anyone 1.5 hours'
  cleaned = cleaned.replace(/\b\d+(\.\d+)?\s*\+\s*VAT\b.*$/gim, '').trim();
  cleaned = cleaned.replace(/£\s*\d+(\.\d+)?\b.*$/gim, '').trim();
  cleaned = cleaned.replace(/\b\d+\s+VAT\b.*$/gim, '').trim();

  // 3. Remove trailing Asana links
  cleaned = cleaned.replace(/https:\/\/app\.asana\.com\S+/gim, '').trim();

  // Clean trailing punctuation, extra spaces, line breaks
  cleaned = cleaned.replace(/[\s\r\n\t]+$/, '').trim();

  return cleaned;
}

async function run() {
  console.log('--- Cleaning Internal Prices & VAT from All Work Order Descriptions ---');

  const [allJobs] = await pool.query('SELECT id, job_number, description FROM work_orders WHERE description IS NOT NULL');
  console.log(`Scanning ${allJobs.length} total work orders...`);

  let updatedCount = 0;

  for (const job of allJobs) {
    const original = job.description;
    const cleaned = cleanDescription(original);

    if (original !== cleaned) {
      await pool.query('UPDATE work_orders SET description = ? WHERE id = ?', [cleaned, job.id]);
      updatedCount++;
      console.log(`[CLEANED] Job #${job.job_number} (ID: ${job.id})`);
    }
  }

  console.log(`\nDone! Successfully removed prices from ${updatedCount} work orders in live DB.`);

  // Verify no VAT remains in any description
  const [remaining] = await pool.query(
    'SELECT count(*) as cnt FROM work_orders WHERE description LIKE ? OR description LIKE ?',
    ['%+ VAT%', '%+VAT%']
  );
  console.log(`Remaining jobs with VAT in description: ${remaining[0].cnt} (Target: 0)`);

  process.exit(0);
}

run().catch(err => {
  console.error('Error cleaning descriptions:', err);
  process.exit(1);
});
