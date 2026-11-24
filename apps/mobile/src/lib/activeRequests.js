// The "Active Requests" section of Home and the card for an active request (shared with My Requests). Pure (no React, no native modules), so every rule is unit-tested.
//
// WHICH requests are active is decided in ONE place, isActiveRequest (lib/myRequestsView.js: submitted + in progress, the same rule as the Active filter of My Requests), so the count on Home
// is always the count of that filter. Nothing here invents progress: the steps are the request's own tracking steps (lib/trackingDetailsView.js buildTrackingDetails, the same ones the
// Tracking Details screen draws), and a card with no steps shows no bar and no step text.
import { isActiveRequest, cardView, serviceKeyOf, badgeFor } from './myRequestsView';
import { buildTrackingDetails } from './trackingDetailsView';
import { baseServiceName, transferTypeKey } from './requestDetailsView';

export const HOME_ACTIVE_MAX = 1; // cards on Home: ONE (the first by the ordering below); with more active requests, "All Active Requests" follows it

// A request that needs something from the person (the review workflow asks for documents or changes) comes first; then the most recently updated.
const NEEDS_ACTION = new Set(['awaiting_documents', 'changes_requested']);
export const needsAction = (item) => !!item && !!item.raw && NEEDS_ACTION.has(item.raw.reviewStatus);
const stamp = (item) => {
  const ms = Date.parse((item && item.raw && item.raw.updatedAt) || (item && item.createdAt) || '');
  return Number.isFinite(ms) ? ms : 0;
};

// The active requests of a list of list items (lib/requestShape.js toListItem), in the order the cards show them. The list's own order is the tie-break (it comes newest first).
export function activeRequestsOf(items) {
  const active = (Array.isArray(items) ? items : []).filter(isActiveRequest).map((item, index) => ({ item, index }));
  active.sort((a, b) => (Number(needsAction(b.item)) - Number(needsAction(a.item))) || (stamp(b.item) - stamp(a.item)) || (a.index - b.index));
  return active.map((entry) => entry.item);
}

// What Home shows: nothing for 0; for 1 or more exactly ONE card (the first by the ordering above), and with 2 or more the "All Active Requests" button after it. `count` is every active request.
export function homeActiveSection(items) {
  const active = activeRequestsOf(items);
  return { active, count: active.length, shown: active.slice(0, HOME_ACTIVE_MAX), hasMore: active.length > HOME_ACTIVE_MAX };
}

const norm = (text) => String(text || '').trim().toLowerCase();

// The service name (shown once) and, where the request has one, its variant: Air Ambulance / Private Charter, Medical Escort / Commercial Airlines, Mortal Remains / its transfer type. A variant that
// is already part of the name is dropped.
export function nameAndVariant(item, t) {
  const key = serviceKeyOf(item);
  let name;
  let variant = '';
  if (key === 'privatecharter' || key === 'air') {
    name = t('svc_air');
    variant = key === 'privatecharter' ? t('tb_short_charter') : '';
  } else if (key === 'commercialair') {
    name = t('tb_chip_commercial');
    variant = t('tb_short_commercial');
  } else {
    name = baseServiceName(item, t);
    const transfer = transferTypeKey(item);
    variant = transfer ? t(transfer) : '';
  }
  if (variant && norm(name).includes(norm(variant))) variant = '';
  return { name, variant };
}

// The progress of THIS request's own workflow: { total, step, stage } for the step it is on, or null when it has no steps (then no bar and no step text are drawn).
export function progressOfRequest(item, t) {
  const details = item && item.raw ? buildTrackingDetails(item.raw, t) : null;
  const steps = details && Array.isArray(details.steps) ? details.steps : [];
  const at = steps.findIndex((s) => s.state === 'current');
  if (!steps.length || at < 0) return null;
  return { total: steps.length, step: at + 1, stage: steps[at].title };
}

// Everything one card draws. `item` is a list item with its `raw` request; `t` is the app's translate function.
export function activeCardView(item, t) {
  const base = cardView(item, t); // the status text, the route (cities only, none for services without one)
  const { name, variant } = nameAndVariant(item, t);
  const progress = progressOfRequest(item, t);
  const stage = progress && norm(progress.stage) !== norm(base.statusLabel) ? progress.stage : ''; // the stage is not repeated when it is the status
  const badge = badgeFor(item.status); // the same mapping as every card of My Requests
  const reference = item.id;
  const stepPhrase = progress ? t('mr_a11y_step', { n: progress.step, total: progress.total }) : '';
  const routePhrase = base.route && base.route.from && base.route.to ? t('mr_a11y_route', { from: base.route.from, to: base.route.to }) : '';
  return {
    key: base.key, id: item.rawId, name, variant, reference, statusLabel: base.statusLabel, badge,
    route: base.route && base.route.from && base.route.to ? base.route : null,
    progress, stage,
    label: [name, variant, reference, base.statusLabel, stepPhrase, stage, routePhrase].filter(Boolean).join(', '),
  };
}
