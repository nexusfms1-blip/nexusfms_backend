const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
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

async function generateUniqueJobNumber(conn) {
  while (true) {
    const rand = Math.floor(1000 + Math.random() * 9000);
    const candidate = `JOB-2026-${rand}`;
    const [existing] = await conn.query('SELECT id FROM work_orders WHERE job_number = ?', [candidate]);
    if (existing.length === 0) {
      return candidate;
    }
  }
}

async function runImport() {
  console.log('--- Starting Safe Append Import of 23-Oct Client Data ---');
  
  const csvPath = 'c:/Users/Administrator/Desktop/kiaan-all-project/nexus-latest-21-oct-26/NEW_CLIENT_DATA_CLEANED_23OCT.csv';
  if (!fs.existsSync(csvPath)) {
    throw new Error(`CSV file not found at: ${csvPath}`);
  }

  const csvRaw = fs.readFileSync(csvPath, 'utf8');
  const allRows = parseCsv(csvRaw);

  const header = allRows[0];
  const records = allRows.slice(1);

  console.log(`CSV Header: ${header.join(' | ')}`);
  console.log(`Total records to process: ${records.length}`);

  // Count existing before import
  const [beforeCount] = await pool.query('SELECT COUNT(*) as cnt FROM work_orders');
  console.log(`Pre-import total work_orders count in DB: ${beforeCount[0].cnt}`);

  let insertedCount = 0;
  let skippedCount = 0;
  let awaitingBookingCount = 0;
  let quotesCount = 0;
  let newResidentsCount = 0;

  const MANAGER_AGENCY_DOMAINS = [
    'jlgroup.uk', 'martinco.com', 'sequencehome.co.uk', 'robertaston.com',
    'burchelledwards.co.uk', 'apmaintenance.uk', 'nexusfms.com', 'allpurposegroup.co.uk'
  ];

  for (let i = 0; i < records.length; i++) {
    const row = records[i];
    const taskId = (row[0] || '').trim();
    const stage = (row[1] || 'Jobs Waiting Booking').trim();
    const woRef = (row[2] || '').trim() || null;
    const title = (row[3] || 'Maintenance Job').trim();
    let resName = (row[4] || '').trim() || null;
    const resPhone = (row[5] || '').trim() || null;
    let resEmail = (row[6] || '').trim() || null;
    const propertyAddress = (row[7] || '').trim() || null;
    const description = (row[8] || '').trim() || null;
    const managerName = (row[9] || 'Office Admin').trim() || 'Office Admin';
    const hours = parseFloat(row[10]) || 1.5;
    const priority = (row[11] || 'NORMAL').trim();

    // Check if resName is accidentally an email (e.g. jason_nichols@hotmail.co.uk)
    if (resName && resName.includes('@') && !resEmail) {
      resEmail = resName;
      resName = resName.split('@')[0].replace(/[._-]/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
    }

    // Check if resEmail actually belongs to a manager/agency
    let managerEmail = null;
    if (resEmail) {
      const lowerEmail = resEmail.toLowerCase();
      const isMgr = MANAGER_AGENCY_DOMAINS.some(d => lowerEmail.endsWith('@' + d) || lowerEmail.includes('@' + d)) ||
                    (managerName && lowerEmail.includes(managerName.toLowerCase().replace(/[^a-z]/g, '')));
      if (isMgr) {
        managerEmail = resEmail;
        resEmail = null; // Do NOT set as tenant's email!
      }
    }

    // Check if task already exists by taskId
    if (taskId) {
      const [existingTask] = await pool.query(
        'SELECT id, job_number FROM work_orders WHERE external_reference_id = ?',
        [taskId]
      );
      if (existingTask.length > 0) {
        console.log(`[SKIP] Task ID ${taskId} already exists as job ${existingTask[0].job_number}`);
        skippedCount++;
        continue;
      }
    }

    // Resolve or insert resident
    let residentId = null;
    if (resPhone || resName) {
      const [existingRes] = await pool.query(
        `SELECT id FROM residents 
         WHERE (phone = ? AND phone != '') 
            OR (full_name = ? AND full_name != '') 
         ORDER BY id DESC LIMIT 1`,
        [resPhone || '', resName || '']
      );

      if (existingRes.length > 0) {
        residentId = existingRes[0].id;
      } else {
        const [resInsert] = await pool.query(
          `INSERT INTO residents (full_name, phone, email, address) VALUES (?, ?, ?, ?)`,
          [resName || 'Resident', resPhone, resEmail, propertyAddress]
        );
        residentId = resInsert.insertId;
        newResidentsCount++;
      }
    }

    // Generate job_number and secure_token
    const jobNumber = await generateUniqueJobNumber(pool);
    const secureToken = `tok_${crypto.randomBytes(32).toString('hex')}`;

    // Coordinates near Birmingham / West Midlands for realistic geo-mapping
    const mockLat = 52.4862 + (Math.random() - 0.5) * 0.15;
    const mockLng = -1.8904 + (Math.random() - 0.5) * 0.15;

    const [woInsertRes] = await pool.query(
      `INSERT INTO work_orders (
        job_number,
        title,
        resident_id,
        resident_name,
        contact_phone,
        contact_email,
        property_address,
        description,
        duration_hours,
        pipeline_stage,
        priority,
        latitude,
        longitude,
        manager_name,
        manager_email,
        secure_token,
        external_reference_id,
        work_order_reference,
        source_type
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        jobNumber,
        title,
        residentId,
        resName,
        resPhone,
        resEmail,
        propertyAddress,
        description,
        hours,
        stage,
        priority,
        mockLat,
        mockLng,
        managerName,
        managerEmail,
        secureToken,
        taskId,
        woRef,
        'CSV_IMPORT'
      ]
    );

    insertedCount++;
    const newWorkOrderId = woInsertRes.insertId;

    if (stage === 'Jobs Waiting Booking') {
      const BookingRequestService = require('../services/bookingRequest.service');
      await BookingRequestService.triggerAutoBookingRequest(newWorkOrderId).catch(err => {
        console.warn(`[IMPORT] Failed to trigger auto booking request for #${jobNumber}:`, err.message);
      });
      awaitingBookingCount++;
    } else if (stage === 'Quotes') {
      const QuoteRequestService = require('../services/quoteRequest.service');
      await QuoteRequestService.triggerAutoPhotoRequest(newWorkOrderId).catch(err => {
        console.warn(`[IMPORT] Failed to trigger auto photo request for #${jobNumber}:`, err.message);
      });
      quotesCount++;
    }

    if (insertedCount % 20 === 0 || insertedCount === records.length) {
      console.log(`Progress: ${insertedCount}/${records.length} jobs inserted...`);
    }
  }

  // Final verification
  const [afterCount] = await pool.query('SELECT COUNT(*) as cnt FROM work_orders');
  const [stagesSummary] = await pool.query(
    'SELECT pipeline_stage, COUNT(*) as cnt FROM work_orders GROUP BY pipeline_stage'
  );

  console.log('\n=============================================');
  console.log('          IMPORT COMPLETED SAFELY            ');
  console.log('=============================================');
  console.log(`Pre-import work_orders:       ${beforeCount[0].cnt}`);
  console.log(`New jobs inserted:            ${insertedCount}`);
  console.log(`- Jobs Waiting Booking added: ${awaitingBookingCount}`);
  console.log(`- Quotes added:               ${quotesCount}`);
  console.log(`Jobs skipped (duplicates):    ${skippedCount}`);
  console.log(`New residents created:        ${newResidentsCount}`);
  console.log(`Post-import total jobs in DB: ${afterCount[0].cnt}`);
  console.log('\nUpdated Pipeline Stages Breakdown:');
  stagesSummary.forEach(s => {
    console.log(`  - ${s.pipeline_stage}: ${s.cnt} jobs`);
  });

  process.exit(0);
}

if (require.main === module) {
  runImport().catch(err => {
    console.error('Fatal import error:', err);
    process.exit(1);
  });
}

module.exports = { runImport };
