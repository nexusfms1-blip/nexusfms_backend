const fs = require('fs');
const path = require('path');
const { pool } = require('../config/db');

function parseCsv(text) {
  const rows = [];
  let currentRow = [];
  let currentField = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const nextChar = text[i + 1];

    if (char === '"') {
      if (inQuotes && nextChar === '"') {
        currentField += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      currentRow.push(currentField);
      currentField = '';
    } else if ((char === '\r' || char === '\n') && !inQuotes) {
      if (char === '\r' && nextChar === '\n') i++;
      currentRow.push(currentField);
      if (currentRow.some(f => f.trim() !== '')) {
        rows.push(currentRow);
      }
      currentRow = [];
      currentField = '';
    } else {
      currentField += char;
    }
  }
  if (currentField || currentRow.length > 0) {
    currentRow.push(currentField);
    if (currentRow.some(f => f.trim() !== '')) rows.push(currentRow);
  }
  return rows;
}

function extractHoursAndPrice(notes) {
  if (!notes) return { hours: null, price: null, cleanWorkDesc: '' };

  let workDesc = notes;

  // Split at divider lines like ----------------------------------------
  if (/---+|===+|___+/.test(notes)) {
    const parts = notes.split(/---+|===+|___+/);
    workDesc = parts[0].trim();
  }

  // 1. Extract Hours
  // Patterns: '4 hours', '1.5 hours', '2.5 hrs', '1 hour', '1hr', '2.5h'
  let hours = null;
  const hourMatch = notes.match(/\b(\d+(\.\d+)?)\s*(hours?|hrs?|h)\b/i);
  if (hourMatch) {
    hours = parseFloat(hourMatch[1]);
  }

  // 2. Extract Price / Total Job Charge
  // Patterns: '£395', '£ 395.00', '120 + VAT', '380+VAT', '115 + VAT', '£395'
  let price = null;
  const poundMatch = notes.match(/£\s*(\d+(\.\d+)?)/i);
  if (poundMatch) {
    price = parseFloat(poundMatch[1]);
  } else {
    const vatMatch = notes.match(/\b(\d+(\.\d+)?)\s*\+\s*VAT/i);
    if (vatMatch) {
      price = parseFloat(vatMatch[1]);
    }
  }

  // 3. Clean Work Description - remove any prices, vat, asana links, or divider remnants
  let cleanDesc = workDesc;
  cleanDesc = cleanDesc.replace(/\b\d+(\.\d+)?\s*\+\s*VAT\b.*$/gim, '').trim();
  cleanDesc = cleanDesc.replace(/£\s*\d+(\.\d+)?\b.*$/gim, '').trim();
  cleanDesc = cleanDesc.replace(/\b\d+\s+VAT\b.*$/gim, '').trim();
  cleanDesc = cleanDesc.replace(/https:\/\/app\.asana\.com\S+/gim, '').trim();
  cleanDesc = cleanDesc.replace(/[\s\r\n\t]+$/, '').trim();

  return { hours, price, cleanWorkDesc: cleanDesc };
}

async function run() {
  console.log('--- Processing All Jobs for Hours Allocation, Total Job Charge & Staff Assignment ---');

  // Load raw CSVs to get exact original notes
  const rootDir = 'c:/Users/Administrator/Desktop/kiaan-all-project/nexus-latest-21-oct-26';
  const awaitingRows = parseCsv(fs.readFileSync(path.join(rootDir, 'Awaiting_JOB_Booking-new.csv'), 'utf8')).slice(1);
  const quotesRows = parseCsv(fs.readFileSync(path.join(rootDir, 'Quotes-new.csv'), 'utf8')).slice(1);

  const rawTasksMap = new Map();
  [...awaitingRows, ...quotesRows].forEach(r => {
    const taskId = (r[0] || '').trim();
    const rawNotes = (r[11] || '').trim();
    if (taskId) {
      rawTasksMap.set(taskId, rawNotes);
    }
  });

  console.log(`Loaded ${rawTasksMap.size} raw tasks from original CSVs.`);

  // Get Gavin and Kavell staff IDs
  const [staffRows] = await pool.query(
    'SELECT sp.id as profile_id, u.full_name FROM staff_profiles sp JOIN users u ON sp.user_id = u.id WHERE u.full_name IN (?, ?)',
    ['Gavin Allen', 'Kavell Lewis']
  );
  console.log('Target Staff Members:', staffRows);

  const gavinProfile = staffRows.find(s => s.full_name.includes('Gavin'));
  const kavellProfile = staffRows.find(s => s.full_name.includes('Kavell'));

  const gavinId = gavinProfile?.profile_id || 95;
  const kavellId = kavellProfile?.profile_id || 96;

  // Multi-select format supporting both numeric and stf- string IDs for frontend compatibility
  const assignedIdsJson = JSON.stringify([gavinId, kavellId, `stf-${gavinId}`, `stf-${kavellId}`]);

  // Fetch all jobs in work_orders
  const [jobs] = await pool.query('SELECT id, job_number, external_reference_id, description, duration_hours, quote_amount, pipeline_stage FROM work_orders');
  console.log(`Scanning ${jobs.length} jobs in live database...`);

  let updatedCount = 0;
  let hoursUpdated = 0;
  let chargeUpdated = 0;

  for (const job of jobs) {
    const taskId = job.external_reference_id;
    const rawNotes = rawTasksMap.get(taskId) || job.description || '';

    const { hours, price, cleanWorkDesc } = extractHoursAndPrice(rawNotes);

    const finalDuration = hours || parseFloat(job.duration_hours) || 1.5;
    const finalCharge = price !== null ? price : (job.quote_amount || null);
    const finalDesc = cleanWorkDesc || job.description;

    if (hours) hoursUpdated++;
    if (price !== null) chargeUpdated++;

    // Update job in database
    await pool.query(
      `UPDATE work_orders SET 
        duration_hours = ?,
        quote_amount = ?,
        description = ?,
        assigned_staff_id = ?,
        assigned_staff_ids = ?
       WHERE id = ?`,
      [
        finalDuration,
        finalCharge,
        finalDesc,
        gavinId,
        assignedIdsJson,
        job.id
      ]
    );

    updatedCount++;
  }

  console.log('\n======================================================');
  console.log(`Successfully updated ${updatedCount} total jobs!`);
  console.log(`- Exact Duration Hours updated: ${hoursUpdated} jobs`);
  console.log(`- Total Job Charge (£) updated: ${chargeUpdated} jobs`);
  console.log(`- Gavin Allen & Kavell Lewis assigned to ALL jobs (Multi-Select)`);
  console.log(`- All prices & internal notes removed from Work Descriptions`);
  console.log('======================================================');

  // Verify Airing Cupboard job specifically (from screenshot)
  const [sample] = await pool.query(
    'SELECT id, job_number, title, duration_hours, quote_amount, assigned_staff_ids, description FROM work_orders WHERE description LIKE ?',
    ['%airing cupboard%']
  );
  console.log('\nSample Verification (From User Screenshot):', sample[0]);

  process.exit(0);
}

run().catch(err => {
  console.error('Fatal execution error:', err);
  process.exit(1);
});
