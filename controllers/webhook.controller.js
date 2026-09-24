const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');
const { pool } = require('../config/db');
const { createWorkOrderEntity } = require('../services/workOrder.service');
const { uploadMediaFile } = require('../services/cloudinary.service');

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
      // 5. Call Shared Work Order Creation Service
      const creationResult = await createWorkOrderEntity(
        {
          title: normalizedTitle,
          resident_name: normalizedResName,
          contact_phone: normalizedPhone,
          contact_email: contact_email || null,
          property_address: normalizedAddress,
          description: normalizedDesc,
          priority: priority || 'NORMAL',
          pipeline_stage: 'Quotes',
          external_reference_id: normalizedRefId,
          original_sender_email: normalizedSenderEmail,
          manager_name: manager_name || 'Email Requester',
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
