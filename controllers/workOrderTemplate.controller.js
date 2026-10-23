/**
 * Work Order Template & PDF Training Controller
 * Allows admins to:
 * 1. Upload sample PDF work orders from new clients
 * 2. Auto-detect fields (AI) and preview raw text lines for visual highlighting
 * 3. Save, update, and manage client extraction templates (learned from highlights)
 * 4. Test parse new PDFs against trained templates (auto-detects which client)
 * 5. Create work orders directly from parsed PDFs
 */

const { pool } = require('../config/db');
const {
  extractPdfText,
  learnRulesFromSelections,
  detectTemplate,
  parseWithTemplate,
  suggestSelections,
} = require('../services/pdfParser.service');
const { createWorkOrderEntity } = require('../services/workOrder.service');
const QuoteRequestService = require('../services/quoteRequest.service');
const { buildWorkReference } = require('../utils/workReference');

const VALID_STAGES = ['Quotes', 'Completed Quotes', 'Jobs Waiting Booking', 'Jobs'];

const parseJson = (val) => {
  if (!val) return null;
  if (typeof val === 'object') return val;
  try { return JSON.parse(val); } catch (_) { return null; }
};

const formatTemplate = (row) => {
  if (!row) return null;
  const mapping = parseJson(row.mapping_rules) || {};
  return {
    ...row,
    mapping_rules: mapping,
    trained_fields: Object.keys(mapping.fields || {}),
    is_active: !!row.is_active,
  };
};

/**
 * Builds mapping_rules JSON from either learned selections or a raw mapping object.
 */
const buildMappingRules = (body, existingMapping = null) => {
  const { selections, lines, mapping_rules } = body;
  if (selections && Array.isArray(lines) && lines.length > 0) {
    return {
      version: 1,
      fields: learnRulesFromSelections(lines, selections),
      selections,
      sampleLines: lines.slice(0, 400),
    };
  }
  if (mapping_rules !== undefined) return parseJson(mapping_rules);
  return existingMapping;
};

// @desc    Upload sample PDF and extract preview text + candidate fields
// @route   POST /api/v1/work-order-templates/upload-sample
// @access  Private (Admin / Office)
const uploadSamplePdf = async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'Please upload a PDF file.' });
    }

    const fileName = req.file.originalname;
    const fileUrl = `/uploads/templates/${req.file.filename}`;

    // 1. Extract PDF raw text and line structure
    const pdfData = await extractPdfText(req.file.path);
    if (!pdfData.lines.length) {
      return res.status(422).json({
        success: false,
        message: 'No readable text found in this PDF. It may be a scanned image — please upload a text-based PDF.',
      });
    }

    // 2. If this PDF already matches a trained client, use that template
    const [templates] = await pool.query('SELECT * FROM work_order_templates WHERE is_active = 1');
    const match = detectTemplate(pdfData.lines, templates);

    // 3. Extract fields (template rules first, AI fills the gaps)
    const { fields, sources } = await parseWithTemplate(pdfData, match ? match.template : null);

    // 4. Pre-highlight the found values in the document so admin can confirm/adjust
    const savedSelections = match ? (parseJson(match.template.mapping_rules) || {}).selections : null;
    const suggested = suggestSelections(pdfData.lines, fields);

    res.status(200).json({
      success: true,
      message: 'Sample PDF parsed successfully.',
      data: {
        fileUrl,
        fileName,
        pageCount: pdfData.numpages,
        rawText: pdfData.rawText,
        lines: pdfData.lines,
        extractedFields: fields,
        fieldSources: sources,
        suggestedSelections: suggested,
        matchedTemplate: match ? { id: match.template.id, client_name: match.template.client_name, score: match.score } : null,
        hasSavedSelections: !!savedSelections,
      },
    });
  } catch (err) {
    next(err);
  }
};

// @desc    Get all trained templates
// @route   GET /api/v1/work-order-templates
// @access  Private
const getTemplates = async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT id, client_name, client_code, sender_email_domain, sample_file_url, sample_file_name,
              mapping_rules, ai_prompt_instructions, default_pipeline_stage, total_processed_count,
              last_used_at, is_active, created_at, updated_at
       FROM work_order_templates
       ORDER BY created_at DESC`
    );

    res.status(200).json({
      success: true,
      count: rows.length,
      data: rows.map(formatTemplate),
    });
  } catch (err) {
    next(err);
  }
};

// @desc    Get single template by ID
// @route   GET /api/v1/work-order-templates/:id
// @access  Private
const getTemplateById = async (req, res, next) => {
  try {
    const [rows] = await pool.query('SELECT * FROM work_order_templates WHERE id = ?', [req.params.id]);
    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Template not found.' });
    }
    res.status(200).json({ success: true, data: formatTemplate(rows[0]) });
  } catch (err) {
    next(err);
  }
};

// @desc    Create a new client template (learns rules from highlighted selections)
// @route   POST /api/v1/work-order-templates
// @access  Private (Admin)
const createTemplate = async (req, res, next) => {
  try {
    const {
      client_name,
      client_code,
      sender_email_domain,
      sample_file_url,
      sample_file_name,
      ai_prompt_instructions,
      default_pipeline_stage = 'Jobs Waiting Booking',
    } = req.body;

    if (!client_name || client_name.trim() === '') {
      return res.status(400).json({ success: false, message: 'Client name is required.' });
    }
    const stage = VALID_STAGES.includes(default_pipeline_stage) ? default_pipeline_stage : 'Jobs Waiting Booking';

    const mapping = buildMappingRules(req.body);
    if (!mapping || !mapping.fields || Object.keys(mapping.fields).length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Please highlight at least one field on the PDF before saving the template.',
      });
    }

    const [result] = await pool.query(
      `INSERT INTO work_order_templates
        (client_name, client_code, sender_email_domain, sample_file_url, sample_file_name, mapping_rules, ai_prompt_instructions, default_pipeline_stage)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        client_name.trim(),
        client_code ? client_code.trim().toUpperCase() : null,
        sender_email_domain ? sender_email_domain.trim().replace(/^@/, '').toLowerCase() : null,
        sample_file_url || null,
        sample_file_name || null,
        JSON.stringify(mapping),
        ai_prompt_instructions || null,
        stage,
      ]
    );

    const [rows] = await pool.query('SELECT * FROM work_order_templates WHERE id = ?', [result.insertId]);

    res.status(201).json({
      success: true,
      message: 'Client template trained and saved successfully!',
      data: formatTemplate(rows[0]),
    });
  } catch (err) {
    next(err);
  }
};

// @desc    Update existing template (re-train or edit details)
// @route   PUT /api/v1/work-order-templates/:id
// @access  Private (Admin)
const updateTemplate = async (req, res, next) => {
  try {
    const { id } = req.params;
    const {
      client_name,
      client_code,
      sender_email_domain,
      sample_file_url,
      sample_file_name,
      ai_prompt_instructions,
      default_pipeline_stage,
      is_active,
    } = req.body;

    const [existing] = await pool.query('SELECT * FROM work_order_templates WHERE id = ?', [id]);
    if (existing.length === 0) {
      return res.status(404).json({ success: false, message: 'Template not found.' });
    }
    const current = existing[0];
    const mapping = buildMappingRules(req.body, parseJson(current.mapping_rules));

    await pool.query(
      `UPDATE work_order_templates
       SET client_name = ?, client_code = ?, sender_email_domain = ?, sample_file_url = ?, sample_file_name = ?,
           mapping_rules = ?, ai_prompt_instructions = ?, default_pipeline_stage = ?, is_active = ?
       WHERE id = ?`,
      [
        client_name !== undefined && client_name.trim() ? client_name.trim() : current.client_name,
        client_code !== undefined ? (client_code ? client_code.trim().toUpperCase() : null) : current.client_code,
        sender_email_domain !== undefined
          ? (sender_email_domain ? sender_email_domain.trim().replace(/^@/, '').toLowerCase() : null)
          : current.sender_email_domain,
        sample_file_url !== undefined ? sample_file_url : current.sample_file_url,
        sample_file_name !== undefined ? sample_file_name : current.sample_file_name,
        mapping ? JSON.stringify(mapping) : null,
        ai_prompt_instructions !== undefined ? ai_prompt_instructions : current.ai_prompt_instructions,
        VALID_STAGES.includes(default_pipeline_stage) ? default_pipeline_stage : current.default_pipeline_stage,
        is_active !== undefined ? (is_active ? 1 : 0) : current.is_active,
        id,
      ]
    );

    const [rows] = await pool.query('SELECT * FROM work_order_templates WHERE id = ?', [id]);
    res.status(200).json({
      success: true,
      message: 'Template updated successfully.',
      data: formatTemplate(rows[0]),
    });
  } catch (err) {
    next(err);
  }
};

// @desc    Delete template (existing work orders keep their data; template_id link is just orphaned)
// @route   DELETE /api/v1/work-order-templates/:id
// @access  Private (Admin)
const deleteTemplate = async (req, res, next) => {
  try {
    const { id } = req.params;
    const [result] = await pool.query('DELETE FROM work_order_templates WHERE id = ?', [id]);
    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: 'Template not found.' });
    }
    await pool.query('UPDATE work_orders SET template_id = NULL WHERE template_id = ?', [id]).catch(() => {});
    res.status(200).json({ success: true, message: 'Template deleted successfully.' });
  } catch (err) {
    next(err);
  }
};

// @desc    Test parse a new PDF (uses chosen template, or auto-detects the client)
// @route   POST /api/v1/work-order-templates/test-parse
// @access  Private
const testParse = async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'Please upload a PDF file to test.' });
    }

    const { template_id, sender_email } = req.body;
    const pdfData = await extractPdfText(req.file.path);
    if (!pdfData.lines.length) {
      return res.status(422).json({
        success: false,
        message: 'No readable text found in this PDF. It may be a scanned image.',
      });
    }

    let template = null;
    let detection = 'none';
    let score = null;

    if (template_id) {
      const [tRows] = await pool.query('SELECT * FROM work_order_templates WHERE id = ?', [template_id]);
      if (tRows.length > 0) { template = tRows[0]; detection = 'manual'; }
    } else {
      const [templates] = await pool.query('SELECT * FROM work_order_templates WHERE is_active = 1');
      const match = detectTemplate(pdfData.lines, templates, sender_email || '');
      if (match) { template = match.template; detection = 'auto'; score = match.score; }
    }

    const { fields, sources } = await parseWithTemplate(pdfData, template);

    res.status(200).json({
      success: true,
      message: 'Test parse successful.',
      data: {
        templateId: template ? template.id : null,
        templateUsed: template ? template.client_name : 'Generic AI Engine',
        defaultStage: template ? template.default_pipeline_stage : 'Jobs Waiting Booking',
        detection,
        matchScore: score,
        fileName: req.file.originalname,
        lines: pdfData.lines,
        extractedFields: fields,
        fieldSources: sources,
      },
    });
  } catch (err) {
    next(err);
  }
};

// @desc    Create Work Order from Parsed PDF data
// @route   POST /api/v1/work-order-templates/create-job
// @access  Private
const createJobFromPdf = async (req, res, next) => {
  try {
    const {
      contactName,
      contactPhone,
      contactEmail,
      workOrderReference,
      address,
      description,
      priority = 'NORMAL',
      section,
      templateId,
    } = req.body;

    if (!contactName || !String(contactName).trim() || !address || !String(address).trim()) {
      return res.status(400).json({
        success: false,
        message: 'Contact name and property address are required to create a Work Order.',
      });
    }
    if (!contactPhone || !String(contactPhone).trim()) {
      return res.status(400).json({ success: false, message: 'Contact phone number is required.' });
    }

    let template = null;
    if (templateId) {
      const [tRows] = await pool.query('SELECT * FROM work_order_templates WHERE id = ?', [templateId]);
      template = tRows[0] || null;
    }

    const stage = VALID_STAGES.includes(section) ? section : (template ? template.default_pipeline_stage : 'Jobs Waiting Booking');
    const clientName = template ? template.client_name : 'PDF Import';
    const senderEmail = template && template.sender_email_domain ? `orders@${template.sender_email_domain}` : '';

    // Title in client format: REF/domain-POSTCODE - max 4 words
    const title = buildWorkReference({
      reference: workOrderReference,
      senderEmail,
      address,
      issue: description,
      managerName: clientName,
    });

    const creationResult = await createWorkOrderEntity({
      title,
      resident_name: String(contactName).trim(),
      contact_phone: String(contactPhone).trim(),
      contact_email: contactEmail ? String(contactEmail).trim() : null,
      property_address: String(address).trim(),
      description: description || 'No description provided in PDF.',
      priority: ['URGENT', 'HIGH', 'NORMAL', 'LOW'].includes(priority) ? priority : 'NORMAL',
      section: stage,
      work_order_reference: workOrderReference || null,
      manager_name: clientName,
      duration_hours: 1.5,
    }, req.user);

    const workOrderId = creationResult.workOrderId;

    // Track source + template usage
    await pool.query(
      `UPDATE work_orders SET source_type = 'PDF_AUTO_PARSED', template_id = ? WHERE id = ?`,
      [template ? template.id : null, workOrderId]
    );
    if (template) {
      await pool.query(
        `UPDATE work_order_templates
         SET total_processed_count = total_processed_count + 1, last_used_at = NOW()
         WHERE id = ?`,
        [template.id]
      );
    }

    // Same behaviour as manual job creation: Quotes stage triggers resident photo request
    if (creationResult.shouldTriggerPhotoRequest) {
      QuoteRequestService.triggerAutoPhotoRequest(workOrderId).catch((err) => {
        console.error('[createJobFromPdf] Error triggering auto photo request:', err.message);
      });
    }

    res.status(201).json({
      success: true,
      message: `Work Order ${creationResult.jobNumber} created in "${stage}".`,
      data: {
        workOrderId,
        jobNumber: creationResult.jobNumber,
        title,
        stage,
      },
    });
  } catch (err) {
    next(err);
  }
};

module.exports = {
  uploadSamplePdf,
  getTemplates,
  getTemplateById,
  createTemplate,
  updateTemplate,
  deleteTemplate,
  testParse,
  createJobFromPdf,
};
