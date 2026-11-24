// What every Bitrix service (worker, inbound processor, reconciliation, recovery, quotation sync) asks of a profile, in one place, so
// the test pipeline (Category 38) and the actual pipeline (Category 0) can never be mixed up. Pure: no network, no database.
//
// Rules:
//   * A service runs for ONE profile: the one named by BITRIX_DEAL_PROFILE (no default). Without it nothing is sent.
//   * A Deal link carries the profile it belongs to. A link with no profile is a record from before profiles existed: it reads as
//     "test", never as "actual". A link of the other profile is refused, not processed.
//   * A Deal read from Bitrix must carry the profile's category and the exact Case reference in the profile's reference field; a Deal of
//     another category (so another pipeline's Deal) never matches.
const { PROFILES, TEST_PROFILE, PROFILE_TEST, PROFILE_ACTUAL, lookupActualStage, referenceFieldOf } = require('./bitrix-profiles');
const { buildDealFields, DealMappingError } = require('./bitrix-deal');
const { buildActualPrivateCharterFields } = require('./bitrix-deal-actual');
const { lookupStage, LOST_REASON_FIELD } = require('./bitrix-deal-stages');

const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

// The profile a stored link belongs to: its stamp, "test" when there is none (legacy), null when the stamp is not a known profile.
function profileOfLink(link) {
  if (!link || link.profile == null) return TEST_PROFILE;
  return typeof link.profile === 'string' && own(PROFILES, link.profile) ? PROFILES[link.profile] : null;
}

// null when `link` may be handled by `active`, otherwise a short code.
function linkProfileProblem(link, active) {
  if (!active) return 'profile_not_configured';
  const profile = profileOfLink(link);
  if (!profile) return 'link_profile_unknown';
  return profile.name === active.name ? null : 'link_profile_mismatch';
}

// The Prisma filter that selects only the links of `profile`. A link with no stamp counts as test only.
function linkProfileWhere(profile) {
  return profile.name === PROFILE_TEST ? { OR: [{ profile: null }, { profile: PROFILE_TEST }] } : { profile: profile.name };
}

// null when `deal` (as crm.deal.get returns it) is the Deal `dealId` of this profile for the Case `reference`, otherwise a code.
function dealProblem(profile, deal, dealId, reference) {
  if (!deal || typeof deal !== 'object') return 'deal_missing';
  const referenceField = referenceFieldOf(profile);
  if (!referenceField) return 'reference_field_not_configured'; // never falls back to the Deal title
  if (dealId != null && String(deal.ID) !== String(dealId)) return 'deal_id_mismatch';
  if (String(deal.CATEGORY_ID) !== String(profile.categoryId)) return 'category_mismatch';
  if (deal[referenceField] !== reference) return 'reference_mismatch';
  return null;
}

// The stage of a Deal as HumanCare understands it, for the profile: { ok: true, entry } | { ok: false, code }.
function lookupProfileStage(profile, stageId, deal, options = {}) {
  if (profile.name === PROFILE_ACTUAL) return lookupActualStage(stageId);
  return lookupStage(stageId, deal, { lostReasonField: options.lostReasonField === undefined ? LOST_REASON_FIELD : options.lostReasonField });
}

// The `fields` of crm.deal.add for the profile. Throws DealMappingError (before anything is sent) when the Case cannot be mapped.
function buildProfileDealFields(profile, caseRecord, request) {
  if (profile.name === PROFILE_ACTUAL) return buildActualPrivateCharterFields(caseRecord, request);
  if (profile.name === PROFILE_TEST) return buildDealFields(caseRecord, request);
  throw new DealMappingError('profile_unknown', 'The Bitrix profile is not known.');
}

// Is this stage one that closes a Deal for the profile (no quotation work, no further stage work)?
const isClosedStage = (profile, stageId) => profile.closedStageIds.includes(stageId);

module.exports = { profileOfLink, linkProfileProblem, linkProfileWhere, dealProblem, lookupProfileStage, buildProfileDealFields, isClosedStage };
