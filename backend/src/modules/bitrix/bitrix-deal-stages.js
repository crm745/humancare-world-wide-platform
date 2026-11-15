// The approved Bitrix24 Category 38 stage -> HumanCare mapping for INBOUND synchronization. Pure data and lookups.
//
//   key              the HumanCare Private Charter stage written to cases.charter_stage and case_stage_events.stage
//   status           the cases.status written with it (the existing vocabulary: submitted | scheduled | in_progress |
//                    completed | cancelled), or null = leave the Case status as it is
//   patientVisible   the stage may notify the patient (Documentation, In Progress, Final invoice, Completed and
//                    Request Cancelled only)
//   message          the FIXED text of that notification. Never built from a Deal field, comment or note.
//
// Unknown stage ids are never guessed: lookupStage() returns a quarantine code instead. The obsolete red On Hold
// stage C38:UC_1PK4XX is deliberately NOT mapped and is quarantined with its own code.
const STAGES = {
  'C38:NEW': { key: 'patient_details', status: 'submitted', patientVisible: false },
  'C38:PREPARATION': { key: 'no_response', status: null, patientVisible: false },
  'C38:PREPAYMENT_INVOIC': { key: 'documentation', status: 'in_progress', patientVisible: true, message: 'Your request is now at the documentation stage. Open the app for details.' },
  'C38:EXECUTING': { key: 'in_progress', status: 'in_progress', patientVisible: true, message: 'Your service is now in progress.' },
  'C38:FINAL_INVOICE': { key: 'final_invoice', status: 'in_progress', patientVisible: true, message: 'Your final invoice has been issued.' },
  'C38:1': { key: 'on_hold', status: null, patientVisible: false },
  'C38:WON': { key: 'completed', status: 'completed', patientVisible: true, message: 'Your service has been completed.' },
  'C38:APOLOGY': { key: 'duplicate', status: null, patientVisible: false },
};

const STAGE_LOST = 'C38:LOSE';
const OBSOLETE_STAGES = new Set(['C38:UC_1PK4XX']);

// Lost reason option ids (Deal Lost). Only the approved one maps; everything else is quarantined.
const LOST_REASON_PATIENT_CANCELLED = '5914';
// Patient Cancelled -> HumanCare "cancelled" (shown to the patient as "Request Cancelled"). Patient-visible, with
// one FIXED message: it never contains the lost-reason text or anything else from Bitrix. Cancelled is terminal:
// the processor never reopens a cancelled or completed Case.
const CANCELLED = {
  key: 'cancelled', status: 'cancelled', patientVisible: true, label: 'Request Cancelled',
  message: 'Your Private Charter request has been cancelled. Please contact our support team if you need assistance.',
};

// The Deal's "Lost reason" list field (confirmed). Its companion text field UF_CRM_1788859072681 is free text
// written by staff: it is never read, never mapped and never shown to patients.
const LOST_REASON_FIELD = 'UF_CRM_1788858985323';

const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

// -> { ok: true, entry } | { ok: false, code }. `deal` is the Deal as read from Bitrix.
function lookupStage(stageId, deal = {}, { lostReasonField = LOST_REASON_FIELD } = {}) {
  if (typeof stageId !== 'string' || stageId === '') return { ok: false, code: 'stage_missing' };
  if (OBSOLETE_STAGES.has(stageId)) return { ok: false, code: 'obsolete_stage' };
  if (stageId === STAGE_LOST) {
    if (!lostReasonField) return { ok: false, code: 'lost_reason_field_not_configured' };
    const reason = deal[lostReasonField];
    if (reason === undefined || reason === null || reason === '') return { ok: false, code: 'lost_reason_missing' };
    if (String(reason) === LOST_REASON_PATIENT_CANCELLED) return { ok: true, entry: CANCELLED };
    return { ok: false, code: 'lost_reason_unmapped' };
  }
  if (!hasOwn(STAGES, stageId)) return { ok: false, code: 'unknown_stage' };
  return { ok: true, entry: STAGES[stageId] };
}

module.exports = { STAGES, STAGE_LOST, LOST_REASON_PATIENT_CANCELLED, LOST_REASON_FIELD, CANCELLED, lookupStage };
