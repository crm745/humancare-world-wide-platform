// Thin wrapper around HumanCare's Bitrix24 inbound webhook (CRM scope).
// BITRIX24_WEBHOOK_URL lives in .env — never hardcode it here.
//
// Every call is fire-and-forget from the caller's point of view: a Bitrix24
// outage must never block a patient's request from being saved in our own
// database. Callers should wrap these in try/catch and log-and-continue.

const { isBitrixSyncEnabled } = require('./bitrix-config');
const fs = require('fs/promises');
const path = require('path');
const { buildLeadFields, medicalReportFields, MEDICAL_REPORT_FIELD } = require('./bitrix-lead');
const { UPLOAD_DIR } = require('../../middleware/upload.middleware');

const WEBHOOK_URL = process.env.BITRIX24_WEBHOOK_URL;
const REQUEST_TIMEOUT_MS = 15000; // Bitrix webhooks normally respond in well under a second.

// Last line of defence: even a caller that forgot to check the switch can't reach
// the CRM while it's off (see bitrix-config.js).
async function callBitrix(method, payload) {
  if (!isBitrixSyncEnabled()) {
    throw new Error('Bitrix24 sync is switched off (BITRIX_SYNC_ENABLED is not "true")');
  }
  if (!WEBHOOK_URL) {
    throw new Error('BITRIX24_WEBHOOK_URL is not set');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(WEBHOOK_URL + method + '.json', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`Bitrix24 ${method} timed out after ${REQUEST_TIMEOUT_MS / 1000}s`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
  // Bitrix always answers with JSON on success; a non-2xx (rate limit, auth failure,
  // a proxy error page) may not — parse defensively so a non-JSON body doesn't throw
  // here and mask the real `!res.ok` failure below with a generic parse error instead.
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    throw new Error(`Bitrix24 ${method} failed (HTTP ${res.status}): ${data.error_description || data.error || 'no error details in response'}`);
  }
  // A 2xx with no `result` is just as ambiguous as an error — treat it as a failure
  // instead of letting `undefined` flow back to the caller and get silently dropped
  // by Prisma's update (which ignores undefined fields), leaving a lead that looks
  // neither successful nor recorded as failed anywhere.
  if (data.result === undefined || data.result === null) {
    throw new Error(`Bitrix24 ${method} returned no result`);
  }
  return data.result;
}

// Creates a Lead in Bitrix24 for a newly-submitted request or case (build the input
// with leadInputFromRequest / leadInputFromCase in bitrix-lead.js). Returns the numeric Bitrix24 lead id
// (store it as bitrixLeadId).
async function createLead(input) {
  return callBitrix('crm.lead.add', { fields: buildLeadFields(input) });
}

// Puts an uploaded medical report (a Document row: name + /uploads/<file>) into the
// lead's "Medical Report" field. Throws like createLead; callers treat it as best-effort.
//
// If that field is a multiple-file field in Bitrix, the files already on the lead are read
// back and sent again by id next to the new one: a plain update would replace them all. If it
// is a single-file field the new file replaces the old one, as before. `comments` (the lead
// comment with every report's name in it) is written in the same call when given.
async function attachMedicalReport(leadId, document, { comments } = {}) {
  const content = await fs.readFile(path.join(UPLOAD_DIR, path.basename(document.fileUrl)));
  const fields = medicalReportFields(document.name, content);
  const lead = await callBitrix('crm.lead.get', { id: leadId });
  const existing = lead && lead[MEDICAL_REPORT_FIELD];
  if (Array.isArray(existing)) {
    const kept = existing.filter((file) => file && file.id).map((file) => ({ id: file.id }));
    fields[MEDICAL_REPORT_FIELD] = [...kept, fields[MEDICAL_REPORT_FIELD]];
  }
  if (comments) fields.COMMENTS = comments;
  return callBitrix('crm.lead.update', { id: leadId, fields });
}

// Best-effort wrapper for the upload endpoints and the retry sweep: the file is already
// saved in our system, so a Bitrix problem is logged, never passed on to the uploader.
// Nothing happens while the switch is off or before the lead exists (the retry sweep
// sends the reports once it creates the lead).
async function sendMedicalReportToBitrix(leadId, document, options) {
  if (!leadId || !isBitrixSyncEnabled()) return false;
  try {
    await attachMedicalReport(leadId, document, options);
    return true;
  } catch (err) {
    console.error(`Bitrix24 medical report upload failed for lead ${leadId}:`, err.message);
    return false;
  }
}

module.exports = { createLead, attachMedicalReport, sendMedicalReportToBitrix };
