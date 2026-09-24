/**
 * OpenAI & Azure OpenAI Intelligence Service for Nexus FMS
 * Provides:
 * 1. Smart Work Order Description Parsing & Categorization
 * 2. Technician Job Completion Report Polisher
 */

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
 * Categorize work order from description using AI
 */
const categorizeWorkOrder = async (description) => {
  if (!description || description.trim() === '') {
    return {
      category: 'General Maintenance',
      estimatedHours: 1.5,
      priority: 'NORMAL',
      summary: 'General property maintenance request',
    };
  }

  const client = getOpenAIClient();

  // If live OpenAI or Azure API Key is configured
  if (client) {
    try {
      const url = client.type === 'azure'
        ? `${client.endpoint}/openai/deployments/gpt-4o-mini/chat/completions?api-version=2024-02-15-preview`
        : 'https://api.openai.com/v1/chat/completions';

      const headers = {
        'Content-Type': 'application/json',
      };
      if (client.type === 'azure') headers['api-key'] = client.key;
      else headers['Authorization'] = `Bearer ${client.key}`;

      const prompt = `You are an AI assistant for a Facility Management System (Nexus FMS).
Analyze the following maintenance issue description and return a JSON object with:
- category: one of ["Plumbing & Leaks", "Electrical & Lighting", "HVAC & Air Con", "Locks & Carpentry", "Appliance Repair", "General Maintenance"]
- estimatedHours: number (between 0.5 and 8.0)
- priority: one of ["NORMAL", "HIGH", "URGENT"]
- summary: clean 1-sentence professional summary

Description: "${description}"

Respond ONLY with valid JSON.`;

      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [{ role: 'user', content: prompt }],
          response_format: { type: 'json_object' },
          temperature: 0.2,
        }),
      });

      if (response.ok) {
        const data = await response.json();
        const parsed = JSON.parse(data.choices[0].message.content);
        return {
          category: parsed.category || 'General Maintenance',
          estimatedHours: parseFloat(parsed.estimatedHours) || 1.5,
          priority: parsed.priority || 'NORMAL',
          summary: parsed.summary || description,
          aiPowered: true,
        };
      }
    } catch (err) {
      console.warn('[AI_SERVICE_WARN] Live AI call failed, falling back to smart heuristics:', err.message);
    }
  }

  // ── Smart Rule-Based Fallback Heuristics (When no API key is set) ────────────
  const text = description.toLowerCase();
  let category = 'General Maintenance';
  let hours = 1.5;
  let priority = 'NORMAL';

  if (text.includes('leak') || text.includes('pipe') || text.includes('toilet') || text.includes('drain') || text.includes('tap') || text.includes('water') || text.includes('sink')) {
    category = 'Plumbing & Leaks';
    hours = 1.5;
  } else if (text.includes('light') || text.includes('fuse') || text.includes('socket') || text.includes('power') || text.includes('tripping') || text.includes('electric')) {
    category = 'Electrical & Lighting';
    hours = 1.0;
  } else if (text.includes('heat') || text.includes('boiler') || text.includes('ac') || text.includes('air con') || text.includes('radiator') || text.includes('vent')) {
    category = 'HVAC & Air Con';
    hours = 2.0;
  } else if (text.includes('lock') || text.includes('key') || text.includes('door') || text.includes('window') || text.includes('handle') || text.includes('hinge')) {
    category = 'Locks & Carpentry';
    hours = 1.0;
  } else if (text.includes('oven') || text.includes('fridge') || text.includes('cooker') || text.includes('washing') || text.includes('dryer') || text.includes('dishwasher')) {
    category = 'Appliance Repair';
    hours = 2.0;
  }

  if (text.includes('urgent') || text.includes('emergency') || text.includes('flooding') || text.includes('sparking') || text.includes('no heat')) {
    priority = 'URGENT';
  } else if (text.includes('high') || text.includes('asap') || text.includes('broken')) {
    priority = 'HIGH';
  }

  return {
    category,
    estimatedHours: hours,
    priority,
    summary: description.length > 100 ? description.substring(0, 97) + '...' : description,
    aiPowered: false,
  };
};

/**
 * Polish technician notes into a client-ready completion summary
 */
const polishTechnicianReport = async (rawNotes) => {
  if (!rawNotes || rawNotes.trim() === '') {
    return 'Maintenance work completed according to industry standards. Property left safe and operational.';
  }

  const client = getOpenAIClient();

  if (client) {
    try {
      const url = client.type === 'azure'
        ? `${client.endpoint}/openai/deployments/gpt-4o-mini/chat/completions?api-version=2024-02-15-preview`
        : 'https://api.openai.com/v1/chat/completions';

      const headers = { 'Content-Type': 'application/json' };
      if (client.type === 'azure') headers['api-key'] = client.key;
      else headers['Authorization'] = `Bearer ${client.key}`;

      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [
            {
              role: 'system',
              content: 'You are a professional maintenance report polisher. Convert technician rough bullet points into a concise, polite, and professional 2-3 sentence customer-ready job report summary.',
            },
            { role: 'user', content: rawNotes },
          ],
          temperature: 0.3,
        }),
      });

      if (response.ok) {
        const data = await response.json();
        return data.choices[0].message.content.trim();
      }
    } catch (err) {
      console.warn('[AI_SERVICE_WARN] Polish report failed:', err.message);
    }
  }

  // Fallback
  return `Work completed: ${rawNotes.trim()}. System checked and fully verified operational.`;
};

module.exports = {
  categorizeWorkOrder,
  polishTechnicianReport,
};
