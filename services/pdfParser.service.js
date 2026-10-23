/**
 * PDF Parsing & Work Order Extraction Service
 * Uses 'pdf-parse' for text extraction and OpenAI for intelligent field mapping.
 */

const fs = require('fs');
const { PDFParse } = require('pdf-parse');
const axios = require('axios');
const dotenv = require('dotenv');

dotenv.config();

// Helper to get OpenAI client details
const getOpenAIClient = () => {
  const apiKey = process.env.OPENAI_API_KEY;
  const azureEndpoint = process.env.AZURE_OPENAI_ENDPOINT;
  const azureApiKey = process.env.AZURE_OPENAI_KEY;

  if (azureEndpoint && azureApiKey) {
    return { type: 'azure', endpoint: azureEndpoint, key: azureApiKey };
  }
  if (apiKey) {
    return { type: 'openai', key: apiKey };
  }
  return null;
};

/**
 * Extract raw text and metadata from a PDF file buffer or path
 */
const extractPdfText = async (filePathOrBuffer) => {
  let parser = null;
  try {
    let dataBuffer;
    if (typeof filePathOrBuffer === 'string') {
      dataBuffer = fs.readFileSync(filePathOrBuffer);
    } else {
      dataBuffer = filePathOrBuffer;
    }

    // pdf-parse v2 class-based API
    parser = new PDFParse({ data: new Uint8Array(dataBuffer) });
    const result = await parser.getText();

    // Strip pdf-parse v2 page separators like "-- 1 of 2 --"
    const rawText = (result.text || '').replace(/^\s*--\s*\d+\s+of\s+\d+\s*--\s*$/gm, '').trim();

    // Split into clean lines for UI mapping
    const lines = rawText
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => line.length > 0);

    return {
      numpages: result.total || (result.pages ? result.pages.length : 1),
      rawText,
      lines,
    };
  } catch (err) {
    console.error('[PDF Parser Error] Failed to extract text from PDF:', err.message);
    const e = new Error(`PDF Parsing failed: ${err.message}`);
    e.status = 422;
    throw e;
  } finally {
    if (parser) {
      try { await parser.destroy(); } catch (_) { /* ignore */ }
    }
  }
};

/**
 * Rule-based heuristic extractor for quick fallback without AI
 */
const extractHeuristics = (rawText) => {
  // UK Phone pattern with optional spaces/dashes (e.g. 07700 900077, +44 7123 456789, 020 7946 0192)
  const phoneMatch = rawText.match(/(?:(?:\+44\s?\(0\)\s?|\+44\s?|0)[1-9](?:[\s.-]?\d){8,10})/);
  const contactPhone = phoneMatch ? phoneMatch[0].replace(/\s+/g, ' ').trim() : '';

  // Email pattern
  const emailMatch = rawText.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
  const contactEmail = emailMatch ? emailMatch[0].trim() : '';

  // Work Order / Reference pattern:
  // 1. Look for explicit keyword labels: Work Order Reference: ABC, Ref No: 123, Job Ref: XYZ
  let reference = '';
  const labeledRefMatch = rawText.match(/(?:Work\s*Order\s*Ref(?:erence)?|Job\s*Ref(?:erence)?|Ref\s*No|PO\s*Number|WO\s*#|Order\s*#)\s*[:#-]?\s*([A-Za-z0-9\/-]{4,30})/i);
  if (labeledRefMatch) {
    reference = labeledRefMatch[1].trim();
  } else {
    // 2. Look for standalone reference patterns (e.g. WO004531/TRUEB32 or 20851/JAMESB90)
    const standaloneRefMatch = rawText.match(/\b(WO[0-9A-Z_-]{4,}|[0-9]{4,6}\/[A-Z0-9_-]{4,})\b/i);
    if (standaloneRefMatch) {
      reference = standaloneRefMatch[1].trim();
    }
  }

  // UK Postcode pattern (e.g. SW1A 1AA, EC1A 1BB, CR0 2YR, M1 1AA)
  const postcodeMatch = rawText.match(/\b([A-Z]{1,2}[0-9][A-Z0-9]?\s?[0-9][A-Z]{2})\b/i);
  let address = '';
  if (postcodeMatch) {
    const postcode = postcodeMatch[0];
    const index = rawText.indexOf(postcode);
    const start = Math.max(0, index - 120);
    const snippet = rawText.substring(start, index + postcode.length);
    // Find lines that look like address lines (ignore Email/Phone lines)
    const candidateLines = snippet
      .split(/\r?\n/)
      .map(s => s.trim())
      .filter(s => s.length > 0 && !/@/i.test(s) && !/(?:phone|tel|email|contact|order|confirmation)/i.test(s));
    
    address = candidateLines.join(', ').replace(/^[\s,]+|[\s,]+$/g, '');
    if (!address.includes(postcode)) {
      address = address ? `${address}, ${postcode}` : postcode;
    }
  }

  return {
    contactPhone,
    contactEmail,
    workOrderReference: reference,
    address,
  };
};

/**
 * Intelligent AI Extractor using OpenAI / Azure OpenAI
 * Accurately detects: Contact name & details, Reference number, Address, Work description
 */
const extractWithAI = async (rawText, customInstructions = '') => {
  const heuristics = extractHeuristics(rawText);
  const client = getOpenAIClient();

  if (!client) {
    // Fallback if no OpenAI key configured
    return {
      contactName: '',
      contactPhone: heuristics.contactPhone,
      contactEmail: heuristics.contactEmail,
      workOrderReference: heuristics.workOrderReference,
      address: heuristics.address,
      description: rawText.slice(0, 300),
      priority: 'NORMAL',
      tradeCategory: 'General Maintenance',
      confidence: 'heuristic',
    };
  }

  try {
    const prompt = `You are an expert Document AI for a Facility Management System (Nexus FMS).
Analyze the following work order PDF text and extract the key operational fields.

CRITICAL FIELDS TO EXTRACT:
1. contactName: Resident/Tenant or Contact person name.
2. contactPhone: Contact phone number (UK format if applicable).
3. contactEmail: Contact email address.
4. workOrderReference: Client Work Order Number, Job Reference, or PO Number (e.g. "20851/JAMESB90", "WO-9921", "REF12345").
5. address: Complete property address including street, city, and UK postcode.
6. description: Clear summary of the maintenance work/issue required.
7. priority: One of ["URGENT", "HIGH", "NORMAL", "LOW"].
8. tradeCategory: Primary trade needed (e.g. "Plumbing & Leaks", "Electrical & Lighting", "Carpentry & Locks", "General Maintenance", "Roofing").

${customInstructions ? `SPECIAL CLIENT TEMPLATE RULES:\n${customInstructions}\n` : ''}

WORK ORDER DOCUMENT TEXT:
"""
${rawText.slice(0, 4000)}
"""

Respond ONLY with a valid JSON object matching this exact schema:
{
  "contactName": "string",
  "contactPhone": "string",
  "contactEmail": "string",
  "workOrderReference": "string",
  "address": "string",
  "description": "string",
  "priority": "NORMAL",
  "tradeCategory": "string"
}`;

    const url = client.type === 'azure'
      ? `${client.endpoint}/openai/deployments/gpt-4o-mini/chat/completions?api-version=2024-02-15-preview`
      : 'https://api.openai.com/v1/chat/completions';

    const headers = { 'Content-Type': 'application/json' };
    if (client.type === 'azure') headers['api-key'] = client.key;
    else headers['Authorization'] = `Bearer ${client.key}`;

    const response = await axios.post(
      url,
      {
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
        response_format: { type: 'json_object' },
      },
      { headers, timeout: 15000 }
    );

    const content = response.data.choices[0].message.content;
    const parsed = JSON.parse(content);

    return {
      contactName: parsed.contactName || '',
      contactPhone: parsed.contactPhone || heuristics.contactPhone,
      contactEmail: parsed.contactEmail || heuristics.contactEmail,
      workOrderReference: parsed.workOrderReference || heuristics.workOrderReference,
      address: parsed.address || heuristics.address,
      description: parsed.description || '',
      priority: parsed.priority || 'NORMAL',
      tradeCategory: parsed.tradeCategory || 'General Maintenance',
      confidence: 'ai',
    };
  } catch (error) {
    console.warn('[AI PDF Parser] OpenAI call failed, falling back to heuristics:', error.message);
    return {
      contactName: '',
      contactPhone: heuristics.contactPhone,
      contactEmail: heuristics.contactEmail,
      workOrderReference: heuristics.workOrderReference,
      address: heuristics.address,
      description: rawText.slice(0, 300),
      priority: 'NORMAL',
      tradeCategory: 'General Maintenance',
      confidence: 'heuristic',
    };
  }
};

/* ------------------------------------------------------------------ */
/*  TEMPLATE LEARNING ENGINE                                            */
/*  Admin highlights values on a sample PDF -> we learn "anchor" rules  */
/*  (the label text around each value). On new PDFs from the same       */
/*  client we find the same anchors and read the value next to them.    */
/* ------------------------------------------------------------------ */

const TEMPLATE_FIELDS = ['contactName', 'contactPhone', 'contactEmail', 'workOrderReference', 'address', 'description'];
const MULTILINE_FIELDS = new Set(['address', 'description']);
const UK_POSTCODE_RE = /\b[A-Z]{1,2}[0-9][A-Z0-9]?\s?[0-9][A-Z]{2}\b/i;
const LABEL_LINE_RE = /^[A-Za-z][A-Za-z0-9 .\/#&()'-]{1,40}:\s*/;

const normalise = (s) => String(s || '').toLowerCase().replace(/[:#\s]+$/g, '').replace(/\s+/g, ' ').trim();

const cleanValue = (s) => String(s || '').replace(/^[\s:#\-–|]+/, '').replace(/[\s,;|]+$/, '').trim();

/**
 * Learn extraction rules from the admin's highlighted selections.
 * selections: { [field]: { lineIndexes: number[], value: string, before?: string, after?: string } }
 */
const learnRulesFromSelections = (lines = [], selections = {}) => {
  const rules = {};

  for (const field of TEMPLATE_FIELDS) {
    const sel = selections[field];
    if (!sel || !Array.isArray(sel.lineIndexes) || sel.lineIndexes.length === 0) continue;

    const idxs = [...sel.lineIndexes].map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n < lines.length).sort((a, b) => a - b);
    if (idxs.length === 0) continue;

    const first = idxs[0];
    const lineCount = idxs[idxs.length - 1] - first + 1;
    const before = String(sel.before || '').trim();
    const after = String(sel.after || '').trim();
    const rule = { lineCount, lineIndex: first, sample: String(sel.value || '').slice(0, 500) };

    if (before) {
      // Value is on the same line as its label, e.g. "Tenant Name: John Smith"
      const labelMatch = before.match(/([A-Za-z][A-Za-z0-9 .\/#&()'-]{0,40}[:#])\s*$/);
      rule.mode = 'same_line';
      rule.anchor = (labelMatch ? labelMatch[1] : before.slice(-40)).trim();
      if (after) {
        const stopLabel = after.match(/^([A-Za-z][A-Za-z0-9 .\/#&()'-]{0,40}:)/);
        rule.stopAt = stopLabel ? stopLabel[1] : after.split(/\s{2,}|\t/)[0].slice(0, 30);
      }
    } else if (first > 0) {
      // Value sits on the line(s) below a label, e.g. "Property Address:" \n "124 High St"
      rule.mode = 'next_lines';
      rule.anchor = lines[first - 1].trim().slice(0, 80);
    } else {
      rule.mode = 'fixed_line';
    }

    rules[field] = rule;
  }

  return rules;
};

const findAnchorLine = (lines, anchor, mode) => {
  const target = normalise(anchor);
  if (!target) return -1;
  for (let i = 0; i < lines.length; i++) {
    const l = normalise(lines[i]);
    if (mode === 'next_lines' ? (l === target || l.startsWith(target)) : l.includes(target)) return i;
  }
  return -1;
};

/** Collect continuation lines for multi-line fields (address / description) */
const collectFollowingLines = (lines, startIdx, field, minCount) => {
  const out = [];
  const maxLines = field === 'description' ? 20 : Math.max(minCount + 2, 6);
  for (let i = startIdx; i < lines.length && out.length < maxLines; i++) {
    const line = lines[i];
    if (out.length >= minCount && LABEL_LINE_RE.test(line)) break; // next labelled field reached
    out.push(line);
    if (field === 'address' && out.length >= minCount && UK_POSTCODE_RE.test(line)) break; // postcode ends an address
  }
  return out;
};

/**
 * Apply learned rules to the lines of a new PDF.
 * Returns { fields, sources } where sources[field] = 'template' when found.
 */
const applyTemplateRules = (lines = [], rules = {}) => {
  const fields = {};
  const sources = {};

  for (const field of TEMPLATE_FIELDS) {
    const rule = rules[field];
    if (!rule) continue;
    let value = '';
    const count = Math.max(1, Number(rule.lineCount) || 1);
    const joiner = field === 'address' ? ', ' : ' ';

    if (rule.mode === 'same_line') {
      const i = findAnchorLine(lines, rule.anchor, 'same_line');
      if (i >= 0) {
        const line = lines[i];
        const pos = line.toLowerCase().indexOf(String(rule.anchor).toLowerCase());
        let rest = pos >= 0 ? line.slice(pos + String(rule.anchor).length) : line;
        if (rule.stopAt) {
          const stopPos = rest.toLowerCase().indexOf(String(rule.stopAt).toLowerCase());
          if (stopPos > 0) rest = rest.slice(0, stopPos);
        }
        const parts = [cleanValue(rest)];
        if (MULTILINE_FIELDS.has(field)) {
          // Address/description may wrap onto following lines
          if (count > 1 || field === 'description') {
            parts.push(...collectFollowingLines(lines, i + 1, field, count - 1));
          }
        } else if (count > 1) {
          parts.push(...lines.slice(i + 1, i + count));
        }
        value = parts.map(cleanValue).filter(Boolean).join(joiner);
      }
    } else if (rule.mode === 'next_lines') {
      const i = findAnchorLine(lines, rule.anchor, 'next_lines');
      if (i >= 0) {
        const taken = MULTILINE_FIELDS.has(field)
          ? collectFollowingLines(lines, i + 1, field, count)
          : lines.slice(i + 1, i + 1 + count);
        value = taken.map(cleanValue).filter(Boolean).join(joiner);
      }
    } else if (rule.mode === 'fixed_line' && Number.isInteger(rule.lineIndex)) {
      value = lines.slice(rule.lineIndex, rule.lineIndex + count).map(cleanValue).filter(Boolean).join(joiner);
    }

    value = cleanValue(value);
    if (value) {
      fields[field] = value;
      sources[field] = 'template';
    }
  }

  return { fields, sources };
};

/** Build extra AI hints from learned rules so the AI fallback is also client-aware */
const buildRuleHints = (rules = {}) => {
  const labels = {
    contactName: 'Contact name', contactPhone: 'Contact phone', contactEmail: 'Contact email',
    workOrderReference: 'Reference number', address: 'Property address', description: 'Work description',
  };
  return Object.entries(rules)
    .filter(([, r]) => r && r.anchor)
    .map(([f, r]) => `- ${labels[f] || f} appears ${r.mode === 'same_line' ? 'after' : 'below'} the label "${r.anchor}"${r.sample ? ` (example: "${String(r.sample).slice(0, 60)}")` : ''}.`)
    .join('\n');
};

const parseRules = (template) => {
  if (!template || !template.mapping_rules) return {};
  let mr = template.mapping_rules;
  if (typeof mr === 'string') {
    try { mr = JSON.parse(mr); } catch (_) { return {}; }
  }
  return (mr && mr.fields) ? mr.fields : (mr || {});
};

/**
 * Pick the best-matching trained template for a PDF (by sender domain and/or anchor matches).
 */
const detectTemplate = (lines = [], templates = [], senderEmail = '') => {
  const domain = (String(senderEmail).split('@')[1] || '').toLowerCase();
  let best = null;
  let bestScore = 0;

  for (const t of templates) {
    if (t.is_active === 0 || t.is_active === false) continue;
    const rules = parseRules(t);
    const anchors = Object.values(rules).filter((r) => r && r.anchor);
    let score = 0;
    if (anchors.length > 0) {
      const hits = anchors.filter((r) => findAnchorLine(lines, r.anchor, r.mode) >= 0).length;
      score = hits / anchors.length;
    }
    const tDomain = String(t.sender_email_domain || '').replace(/^@/, '').toLowerCase();
    if (domain && tDomain && (domain === tDomain || domain.endsWith(`.${tDomain}`))) score += 1;
    if (score > bestScore) { bestScore = score; best = t; }
  }

  return bestScore >= 0.5 ? { template: best, score: Number(bestScore.toFixed(2)) } : null;
};

/**
 * Full pipeline: template rules first, then AI/heuristics only fill missing fields.
 */
const parseWithTemplate = async (pdfData, template = null) => {
  const rules = parseRules(template);
  const { fields: tplFields, sources } = applyTemplateRules(pdfData.lines, rules);

  const missing = TEMPLATE_FIELDS.filter((f) => !tplFields[f]);
  let aiFields = {};
  if (missing.length > 0) {
    const hints = [template && template.ai_prompt_instructions, buildRuleHints(rules)].filter(Boolean).join('\n');
    aiFields = await extractWithAI(pdfData.rawText, hints);
  }

  const fields = {};
  for (const f of TEMPLATE_FIELDS) {
    if (tplFields[f]) {
      fields[f] = tplFields[f];
    } else if (aiFields[f]) {
      fields[f] = aiFields[f];
      sources[f] = aiFields.confidence === 'ai' ? 'ai' : 'heuristic';
    } else {
      fields[f] = '';
    }
  }
  fields.priority = aiFields.priority || 'NORMAL';
  fields.tradeCategory = aiFields.tradeCategory || '';

  return { fields, sources };
};

/**
 * Locate extracted values inside the PDF lines so the UI can pre-highlight them
 * (turns an AI auto-detect into trainable selections).
 */
const suggestSelections = (lines = [], fields = {}) => {
  const selections = {};
  for (const field of TEMPLATE_FIELDS) {
    const value = String(fields[field] || '').trim();
    if (!value) continue;

    // Single-line match
    const lower = value.toLowerCase();
    const idx = lines.findIndex((l) => l.toLowerCase().includes(lower));
    if (idx >= 0) {
      const pos = lines[idx].toLowerCase().indexOf(lower);
      selections[field] = {
        lineIndexes: [idx],
        value: lines[idx].slice(pos, pos + value.length),
        before: lines[idx].slice(0, pos),
        after: lines[idx].slice(pos + value.length),
      };
      continue;
    }

    // Multi-line match (e.g. address split over several lines)
    const parts = value.split(/,\s*|\n/).map((p) => p.trim().toLowerCase()).filter((p) => p.length > 1);
    const hitIdxs = [];
    parts.forEach((p) => {
      const i = lines.findIndex((l, k) => !hitIdxs.includes(k) && l.toLowerCase().includes(p));
      if (i >= 0) hitIdxs.push(i);
    });
    if (hitIdxs.length >= 2) {
      hitIdxs.sort((a, b) => a - b);
      const range = [];
      for (let k = hitIdxs[0]; k <= hitIdxs[hitIdxs.length - 1] && range.length < 8; k++) range.push(k);
      selections[field] = {
        lineIndexes: range,
        value: range.map((k) => lines[k]).join(field === 'address' ? ', ' : ' '),
        before: '',
        after: '',
      };
    }
  }
  return selections;
};

module.exports = {
  TEMPLATE_FIELDS,
  extractPdfText,
  extractHeuristics,
  extractWithAI,
  learnRulesFromSelections,
  applyTemplateRules,
  detectTemplate,
  parseWithTemplate,
  suggestSelections,
  parseRules,
};

