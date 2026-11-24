// The eight independent service queues, one per CANONICAL service (modules/services/services.data.js, the slugs stored in the `services` table).
// The registry is BUILT from that list, so it can never gain a ninth service, lose one or rename one by accident (a test compares the two).
//
// Each queue owns its own Bitrix24 settings. Nothing is shared between queues and nothing is copied from Private Charter. A queue with
// `active: false` has no pipeline, stage, field or approval configuration yet: the gateway refuses to start it, so activating another service means
// filling in ITS OWN entry (and its own mapping module), never reusing another service's ids.
//
//   slug         the canonical service slug
//   requestKeys  the request kinds (ServiceRequest.serviceKey) this queue delivers. Private Charter is a kind of AIR AMBULANCE, not a service of its
//                own: it lives under `air_ambulance`. Commercial Charter ("commercialair") is the other air kind and is deliberately NOT mapped
//                (bitrix-profiles.js: only Private Charter is implemented), so it is not listed.
//   profile      the Bitrix profile name (bitrix-profiles.js) the queue's Deals use, or null while none exists
//   outboxEventTypes  the outbox event types the queue delivers
//   approval     how a request reaches the queue ("review" = the request-review workflow, null = not defined yet)
const SERVICES = require('../../services/services.data');

const inactive = (slug, label) => Object.freeze({ slug, label, active: false, requestKeys: Object.freeze([]), profile: null, outboxEventTypes: Object.freeze([]), approval: null });

// The only entry with configuration: Air Ambulance, for Private Charter requests, on the actual (Category 0) profile. It references the profile by
// NAME; the category, stage and field ids stay in bitrix-profiles.js, where they already live.
const ACTIVE = Object.freeze({
  air_ambulance: Object.freeze({
    slug: 'air_ambulance', label: 'Air Ambulance (Private Charter)', active: true, requestKeys: Object.freeze(['privatecharter']),
    profile: 'actual', outboxEventTypes: Object.freeze(['bitrix.deal.create']), approval: 'review',
  }),
});

const SERVICE_QUEUES = Object.freeze(Object.fromEntries(SERVICES.map((s) => [s.slug, ACTIVE[s.slug] || inactive(s.slug, s.name)])));

const serviceQueue = (slug) => (Object.prototype.hasOwnProperty.call(SERVICE_QUEUES, slug) ? SERVICE_QUEUES[slug] : null);
// The queue that delivers a request kind, or null.
const queueForRequestKey = (serviceKey) => Object.values(SERVICE_QUEUES).find((q) => q.requestKeys.includes(serviceKey)) || null;

// The queue every Private Charter Bitrix worker belongs to.
const PRIVATE_CHARTER_QUEUE = 'air_ambulance';

// How often a queue LOOKS for work. This is a schedule, not a send rate: the gateway's limiter decides how fast calls actually go out.
const QUEUE_POLL_INTERVAL_MS = 60 * 1000;

module.exports = { SERVICE_QUEUES, serviceQueue, queueForRequestKey, PRIVATE_CHARTER_QUEUE, QUEUE_POLL_INTERVAL_MS };
