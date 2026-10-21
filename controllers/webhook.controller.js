const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');
const { pool } = require('../config/db');
const { createWorkOrderEntity } = require('../services/workOrder.service');
const { uploadMediaFile } = require('../services/cloudinary.service');
// Resilient loader for work reference builder with standalone fallback
let buildWorkReference;
let extractReferenceFromText;
try {
  const wr = require('../utils/workReference');
  buildWorkReference = wr.buildWorkReference;
  extractReferenceFromText = wr.extractReferenceFromText;
} catch (e) {
  // Standalone fallback in case utils/workReference.js is not yet present on remote deployment
  const SECOND_LEVEL_LABELS = new Set(['co', 'com', 'org', 'net', 'ac', 'gov', 'ltd', 'plc', 'me', 'sch', 'nhs', 'police', 'mod']);
  const extractSenderDomain = (email, fallbackName = '') => {
    if (!email || typeof email !== 'string') return fallbackName ? fallbackName.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 15) : '';
    const match = email.match(/@([A-Za-z0-9.-]+)/);
    if (!match) return '';
    const labels = match[1].toLowerCase().replace(/\.+$/, '').split('.').filter(Boolean);
    if (labels.length === 0) return '';
    if (labels.length === 1) return labels[0];
    labels.pop();
    if (labels.length > 1 && SECOND_LEVEL_LABELS.has(labels[labels.length - 1])) labels.pop();
    const extracted = labels[labels.length - 1] || '';
    const genericDomains = new Set(['gmail', 'googlemail', 'yahoo', 'hotmail', 'outlook', 'live', 'icloud', 'aol']);
    if (genericDomains.has(extracted) && fallbackName) {
      const cleanName = fallbackName.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 15);
      if (cleanName) return cleanName;
    }
    return extracted;
  };
  const extractPostcodeOutward = (address) => {
    if (!address || typeof address !== 'string') return '';
    const fullPostcodeRegex = /\b([A-Z]{1,2}\d[A-Z\d]?)\s*(\d[A-Z]{2})\b/gi;
    let lastMatch = null, m;
    while ((m = fullPostcodeRegex.exec(address)) !== null) lastMatch = m;
    if (lastMatch) return lastMatch[1].toUpperCase();
    const outwardRegex = /\b([A-Z]{1,2}\d[A-Z\d]?)\b/gi;
    const matches = [...address.matchAll(outwardRegex)];
    return matches.length > 0 ? matches[matches.length - 1][1].toUpperCase() : '';
  };
  const summariseJob = (text, maxWords = 4) => {
    if (!text || typeof text !== 'string') return '';
    return text.replace(/[\r\n\t]+/g, ' ').replace(/[^\w\s'&-]/g, ' ').split(/\s+/).filter(w => w && w !== '-').slice(0, maxWords).join(' ').trim();
  };
  extractReferenceFromText = (text) => {
    if (!text || typeof text !== 'string') return '';
    const directMatch = text.match(/\b((?:WO|REF|JOB)[-_]\d{3,10})\b/i);
    if (directMatch) return directMatch[1].trim().toUpperCase();
    const lines = text.split(/\r?\n/);
    for (const rawLine of lines) {
      const line = rawLine.trim();
      const lineMatch = line.match(/^(?:ref(?:erence)?|works?\s*orders?|wo|job(?:\s*ref(?:erence)?)?)\s*(?:no\.?|num(?:ber)?|#)?\s*[:=-]\s*([A-Za-z0-9_-]{2,25})$/i);
      if (lineMatch && !/^(no|num|number|date|for|the|details)$/i.test(lineMatch[1])) return lineMatch[1].trim();
    }
    const labelMatch = text.match(/\b(?:works?\s*orders?|job|wo)?\s*(?:ref(?:erence)?|wo|job)\s*(?:no\.?|num(?:ber)?|#)?[\s:=#-]+([A-Za-z0-9_-]{2,25})\b/i);
    if (labelMatch && !/^(no|num|number|for|is|to|the|of|in|at|and|a|an|date|details)$/i.test(labelMatch[1])) return labelMatch[1].trim();
    const fallbackDirect = text.match(/\b((?:WO|REF|JOB)\d{3,10})\b/i);
    if (fallbackDirect) return fallbackDirect[1].trim().toUpperCase();
    return '';
  };
  buildWorkReference = ({ reference, senderEmail, address, issue, managerName, defaultJobNumber, description, subject } = {}) => {
    let ref = (reference || '').toString().trim();
    if (/^(no|num|number|null|undefined|none)$/i.test(ref)) ref = '';
    if (!ref && description) ref = extractReferenceFromText(description);
    if (!ref && subject) ref = extractReferenceFromText(subject);
    if (!ref && issue) ref = extractReferenceFromText(issue);
    if (!ref && defaultJobNumber) ref = defaultJobNumber.toString().trim();
    const domain = extractSenderDomain(senderEmail, managerName);
    const postcode = extractPostcodeOutward(address);
    let issueText = (issue || '').toString();
    if (managerName && typeof managerName === 'string') {
      const escaped = managerName.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (escaped) issueText = issueText.replace(new RegExp(`\\b${escaped}\\b`, 'gi'), ' ');
    }
    if (ref && ref.length >= 3) {
      const escapedRef = ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      issueText = issueText.replace(new RegExp(`\\b${escapedRef}\\b`, 'gi'), ' ');
    }
    issueText = issueText.replace(/\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/gi, ' ').replace(/^works?\s+orders?\s*[-:]?\s*/i, '').replace(/^maintenance\s+request\s*[-:]?\s*/i, '').replace(/^job\s+request\s*[-:]?\s*/i, '').replace(/^\s*[-:/|]+\s*/, '').trim();
    let words = summariseJob(issueText, 4);
    if (!words || words.length < 2) words = 'Maintenance Request';
    const middle = [domain, postcode].filter(Boolean).join('-');
    let head = '';
    if (ref && middle) head = `${ref}/${middle}`;
    else if (ref) head = ref;
    else if (middle) head = middle;
    const result = head ? `${head} - ${words}` : words;
    return result.slice(0, 255);
  };
}

// Strict allowed MIME types for initial customer evidence attachments (P0-Attachments)
const ALLOWED_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'application/pdf',
];
const MAX_FILE_SIZE = 15 * 1024 * 1024; // 15MB per file

/**
 * @desc    Receive external webhook from n8n to create a Quote (Work Order) from email
 * @route   POST /api/v1/webhooks/quotes
 * @access  Private (Protected by x-api-key matching WEBHOOK_SECRET_KEY)
 */
const handleIncomingEmailQuote = async (req, res) => {
  const stagedFilesToCleanup = [];
  // P0-2: Track every Cloudinary public_id uploaded during this request.
  // If the DB transaction is later rolled back, these are deleted from Cloudinary.
  const uploadedCloudinaryPublicIds = [];

  try {
    const {
      reference_id,
      subject,
      title,
      resident_name,
      contact_phone,
      contact_email,
      property_address,
      description,
      priority,
      original_sender_email,
      manager_name,
      manager_email,
      attachments,
    } = req.body;

    // 1. Mandatory Fields Validation (P0-2 & P0-10)
    const normalizedTitle = (title || subject || '').trim();
    const normalizedResName = (resident_name || '').trim();
    const normalizedPhone = (contact_phone || '').trim();
    const normalizedAddress = (property_address || '').trim();
    const normalizedDesc = (description || '').trim();
    const normalizedSenderEmail = (original_sender_email || '').trim();
    const rawRefId = (reference_id || '').trim();

    if (!rawRefId) {
      return res.status(400).json({
        success: false,
        message: 'Validation Error: reference_id (InternetMessageId) is required.',
      });
    }

    // Normalized canonical RFC 5322 Message-ID (max 255 chars)
    const normalizedRefId = rawRefId.slice(0, 255);

    if (!normalizedTitle) {
      return res.status(400).json({
        success: false,
        message: 'Validation Error: title (or subject) is required.',
      });
    }
    if (!normalizedResName) {
      return res.status(400).json({
        success: false,
        message: 'Validation Error: resident_name is required.',
      });
    }
    if (!normalizedPhone) {
      return res.status(400).json({
        success: false,
        message: 'Validation Error: contact_phone is required.',
      });
    }
    if (!normalizedAddress) {
      return res.status(400).json({
        success: false,
        message: 'Validation Error: property_address is required.',
      });
    }
    if (!normalizedDesc) {
      return res.status(400).json({
        success: false,
        message: 'Validation Error: description is required. Empty or missing issue description is rejected.',
      });
    }
    if (!normalizedSenderEmail) {
      return res.status(400).json({
        success: false,
        message: 'Validation Error: original_sender_email is required.',
      });
    }

    // 2. Idempotency Check (P0-6): Check if this email was already ingested
    const [existingWo] = await pool.query(
      'SELECT id, job_number FROM work_orders WHERE external_reference_id = ? LIMIT 1',
      [normalizedRefId]
    );

    if (existingWo.length > 0) {
      return res.status(200).json({
        success: true,
        duplicated: true,
        workOrderId: existingWo[0].id,
        jobNumber: existingWo[0].job_number,
        message: 'Duplicate webhook. Work order already exists for this email reference.',
      });
    }

    // 3. Process & Stage Attachments (P0-1, P0-7: Done BEFORE DB commit)
    const processedAttachments = [];
    if (Array.isArray(attachments) && attachments.length > 0) {
      const uploadDir = path.join(__dirname, '..', 'uploads');
      if (!fs.existsSync(uploadDir)) {
        fs.mkdirSync(uploadDir, { recursive: true });
      }

      for (let i = 0; i < attachments.length; i++) {
        const att = attachments[i];
        if (!att) continue;

        // Path Traversal Prevention (P1-11): Sanitize file name strictly
        const rawFileName = att.file_name || `attachment_${Date.now()}_${i}.bin`;
        const baseName = path.basename(rawFileName).replace(/[^a-zA-Z0-9._-]/g, '_');
        const uniqueFileName = `email_${Date.now()}_${i}_${baseName}`;
        const localFilePath = path.join(uploadDir, uniqueFileName);

        try {
          let fileSizeBytes = 0;
          let contentType = (att.mime_type || '').toLowerCase().trim();

          if (att.file_url) {
            // Fetch from URL (e.g. Graph API temporary media URL)
            const fileResp = await fetch(att.file_url);
            if (!fileResp.ok) {
              throw new Error(`Failed to download attachment '${baseName}': HTTP ${fileResp.status}`);
            }

            const headerContentType = fileResp.headers.get('content-type');
            if (headerContentType) {
              contentType = headerContentType.split(';')[0].trim().toLowerCase();
            }

            const fileStream = fs.createWriteStream(localFilePath);
            const readableWebStream = Readable.fromWeb(fileResp.body);
            await pipeline(readableWebStream, fileStream);
          } else if (att.base64_data) {
            // Decoded from base64 binary buffer
            const buffer = Buffer.from(att.base64_data, 'base64');
            fs.writeFileSync(localFilePath, buffer);
          } else {
            throw new Error(`Attachment '${baseName}' has no file_url or base64_data.`);
          }

          stagedFilesToCleanup.push(localFilePath);
          const stats = fs.statSync(localFilePath);
          fileSizeBytes = stats.size;

          // Validate file size (15MB cap)
          if (fileSizeBytes > MAX_FILE_SIZE) {
            throw new Error(`Attachment '${baseName}' exceeds maximum size of 15MB (${fileSizeBytes} bytes).`);
          }

          // Validate MIME type against whitelist
          if (!ALLOWED_MIME_TYPES.includes(contentType)) {
            // If contentType was generic octet-stream, infer from extension
            const ext = path.extname(baseName).toLowerCase();
            if (ext === '.jpg' || ext === '.jpeg') contentType = 'image/jpeg';
            else if (ext === '.png') contentType = 'image/png';
            else if (ext === '.webp') contentType = 'image/webp';
            else if (ext === '.gif') contentType = 'image/gif';
            else if (ext === '.pdf') contentType = 'application/pdf';
            else {
              throw new Error(`Attachment '${baseName}' has unsupported MIME type: ${contentType}`);
            }
          }

          // Upload to Cloudinary (with automatic fallback to local disk)
          const multerShim = {
            path: localFilePath,
            filename: uniqueFileName,
            originalname: baseName,
            mimetype: contentType,
            size: fileSizeBytes,
          };

          const uploadResult = await uploadMediaFile(multerShim, 'customer_media');
          const finalUrl = uploadResult?.url || `/uploads/${uniqueFileName}`;
          // P0-2: Record the Cloudinary public_id so we can delete it on DB rollback.
          if (uploadResult?.public_id) {
            uploadedCloudinaryPublicIds.push(uploadResult.public_id);
          }
          const isVideo = contentType.startsWith('video');
          const mediaType = isVideo ? 'VIDEO' : 'PHOTO';

          processedAttachments.push({
            fileName: baseName,
            filePath: finalUrl,
            fileSize: fileSizeBytes,
            mimeType: contentType,
            mediaType,
          });

        } catch (attError) {
          console.error(`[Webhook Attachment Error] Failed to process attachment '${baseName}':`, attError.message);
          // Clean up any local files staged in this run
          for (const stagedFile of stagedFilesToCleanup) {
            if (fs.existsSync(stagedFile)) {
              try { fs.unlinkSync(stagedFile); } catch (e) {}
            }
          }
          // P0-1: Any attachment failure MUST prevent successful processing and leave email UNREAD
          return res.status(422).json({
            success: false,
            message: `Attachment processing failed: ${attError.message}. Work order not created; email will remain unread.`,
          });
        }
      }
    }

    // 4. Begin Atomic DB Transaction (P0-7)
    const conn = await pool.getConnection();
    await conn.beginTransaction();

    let createdWorkOrderId = null;
    let createdJobNumber = null;

    try {
      // Clean title format to match client & Asana specification: [Ref / Agent - Issue]
      let cleanJobTitle = normalizedTitle
        .replace(/^works?\s+orders?\s*[-:]?\s*(?:maintenance\s+request\s*[-:]?\s*)?/i, '')
        .trim();

      if (normalizedAddress) {
        const cleanAddr = normalizedAddress.split(',')[0].trim();
        if (cleanAddr && cleanJobTitle.toLowerCase().includes(cleanAddr.toLowerCase())) {
          const parts = cleanJobTitle.split(/[-:]/);
          if (parts.length > 1) {
            cleanJobTitle = parts[parts.length - 1].trim();
          }
        }
      }

      const mgrDisplayName = manager_name || req.body.manager_name || 'Email Requester';
      
      // Look for external reference in payload (work_order_reference, reference_number, reference, job_reference)
      // or extract directly from email description (body), subject, or title
      let refNumber = req.body.work_order_reference || req.body.reference_number || req.body.reference || req.body.job_reference || null;
      if (!refNumber && normalizedDesc) {
        refNumber = extractReferenceFromText(normalizedDesc);
      }
      if (!refNumber && subject) {
        refNumber = extractReferenceFromText(subject);
      }
      if (!refNumber && normalizedTitle) {
        refNumber = extractReferenceFromText(normalizedTitle);
      }

      // Pre-assign unique job number so it can act as the fallback reference if sender didn't include one
      const randomNumber = Math.floor(1000 + Math.random() * 9000);
      const preassignedJobNumber = `JOB-2026-${randomNumber}`;

      // Client format: JOB REFERENCE/DOMAIN OF SENDER-FIRST HALF OF POSTCODE - MAX 4 WORDS OF JOB
      // e.g. "76680/apmestates-B31 - Kitchen Cupboards Peeling"
      cleanJobTitle = buildWorkReference({
        reference: refNumber,
        senderEmail: normalizedSenderEmail,
        address: normalizedAddress,
        issue: cleanJobTitle || normalizedTitle || normalizedDesc,
        managerName: mgrDisplayName,
        defaultJobNumber: preassignedJobNumber,
        description: normalizedDesc,
        subject: subject,
      });

      // 5. Call Shared Work Order Creation Service
      const creationResult = await createWorkOrderEntity(
        {
          job_number: preassignedJobNumber,
          title: cleanJobTitle || normalizedTitle,
          resident_name: normalizedResName,
          contact_phone: normalizedPhone,
          contact_email: contact_email || null,
          property_address: normalizedAddress,
          description: normalizedDesc,
          priority: priority || 'NORMAL',
          pipeline_stage: 'Quotes',
          external_reference_id: normalizedRefId,
          original_sender_email: normalizedSenderEmail,
          work_order_reference: refNumber,
          manager_name: mgrDisplayName,
          manager_email: manager_email || normalizedSenderEmail,
        },
        null,
        conn
      );

      createdWorkOrderId = creationResult.workOrderId;
      createdJobNumber = creationResult.jobNumber;

      // 6. Find the quote_request_id created by triggerAutoPhotoRequest (or link as initial customer evidence)
      const [qrRows] = await conn.query(
        'SELECT id FROM quote_requests WHERE work_order_id = ? ORDER BY id DESC LIMIT 1',
        [createdWorkOrderId]
      );
      const quoteRequestId = qrRows.length > 0 ? qrRows[0].id : null;

      // 7. Insert Attachment Records into customer_media_uploads (P0-4)
      for (const media of processedAttachments) {
        await conn.query(
          `INSERT INTO customer_media_uploads 
            (work_order_id, quote_request_id, media_type, file_name, file_path, file_size_bytes, mime_type)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            createdWorkOrderId,
            quoteRequestId,
            media.mediaType,
            media.fileName,
            media.filePath,
            media.fileSize,
            media.mimeType,
          ]
        );
      }

      // 8. Commit Transaction
      await conn.commit();
      conn.release();

      // P0-1: Photo-request SMS/email fires ONLY after successful DB commit.
      // This guarantees the tenant is never notified for a work order that was rolled back.
      if (creationResult.shouldTriggerPhotoRequest) {
        const QuoteRequestService = require('../services/quoteRequest.service');
        QuoteRequestService.triggerAutoPhotoRequest(createdWorkOrderId).catch(err => {
          console.error('[Webhook Quotes] Error triggering post-commit photo request:', err.message);
        });
      }

      console.log(`[Webhook Quotes] ✓ Successfully created Work Order #${createdJobNumber} (ID: ${createdWorkOrderId}) from email reference ${normalizedRefId}`);

      return res.status(201).json({
        success: true,
        workOrderId: createdWorkOrderId,
        jobNumber: createdJobNumber,
        attachmentsCount: processedAttachments.length,
        message: 'Work order created successfully from email automation.',
      });

    } catch (dbError) {
      await conn.rollback();
      conn.release();

      // P0-2: Best-effort Cloudinary cleanup after DB rollback.
      // The original DB error is preserved and re-thrown regardless of cleanup outcome.
      if (uploadedCloudinaryPublicIds.length > 0) {
        try {
          const cloudinary = require('cloudinary').v2;
          for (const publicId of uploadedCloudinaryPublicIds) {
            try {
              await cloudinary.uploader.destroy(publicId);
              console.log(`[Webhook Quotes] Cloudinary cleanup: deleted orphan object '${publicId}'`);
            } catch (cdnErr) {
              console.error(`[Webhook Quotes] Cloudinary cleanup FAILED for '${publicId}':`, cdnErr.message);
            }
          }
        } catch (cdnModuleErr) {
          console.error('[Webhook Quotes] Could not load cloudinary module for cleanup:', cdnModuleErr.message);
        }
      }

      // P0-6: Handle concurrent duplicate insert race condition (MySQL ER_DUP_ENTRY / 1062)
      if (dbError.code === 'ER_DUP_ENTRY' || dbError.errno === 1062) {
        console.warn(`[Webhook Quotes] ⚡ Concurrent duplicate detected for reference: ${normalizedRefId}`);
        const [dupCheck] = await pool.query(
          'SELECT id, job_number FROM work_orders WHERE external_reference_id = ? LIMIT 1',
          [normalizedRefId]
        );
        if (dupCheck.length > 0) {
          return res.status(200).json({
            success: true,
            duplicated: true,
            workOrderId: dupCheck[0].id,
            jobNumber: dupCheck[0].job_number,
            message: 'Duplicate webhook caught on constraint. Work order already exists.',
          });
        }
      }

      console.error('[Webhook Quotes DB Error]', dbError);
      throw dbError;
    }

  } catch (error) {
    console.error('[Webhook Fatal Error]', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Internal server error while processing quote webhook.',
    });
  }
};

module.exports = {
  handleIncomingEmailQuote,
};
