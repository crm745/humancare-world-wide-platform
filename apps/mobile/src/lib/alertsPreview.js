// Fictional alerts for previewing the existing Notifications (Alerts) screen. UI preview data only: none of it is
// a real patient, case or notification, nothing here is sent to or read from the backend, and it is used only when
// the screen's development-only preview switch is on (see app/notifications.js).
export const ALERTS_PREVIEW_ITEMS = [
  { id: 'p1', group: 'today', category: 'flight', title: 'Air Ambulance, handover at 02:40', body: 'Case HC-2026-4821 left Dubai at 21:28. Patient handover confirmed.', time: '21:28', unread: true },
  { id: 'p2', group: 'today', category: 'quote', title: 'Quote ready to approve', body: 'Commercial stretcher, Sharjah – Kochi. Quote is ready for review.', time: '19:55', unread: true },
  { id: 'p3', group: 'today', category: 'message', title: 'New message from Dr. Rahman', body: 'Uploaded the fitness-to-fly certificate to your case.', time: '19:34', unread: false },
  { id: 'p4', group: 'today', category: 'hospital', title: 'Bed confirmed', body: 'Cardiac ICU bed held at Lilavati Hospital, Mumbai.', time: '19:02', unread: false },
  { id: 'p5', group: 'yesterday', category: 'documents', title: 'Battery of documents expires soon', body: 'Patient passport copy is 11 months old. Airlines may refuse it.', time: '16:10', unread: false },
  { id: 'p6', group: 'yesterday', category: 'request', title: 'Request closed', body: 'Hospital admission HC-2026-4402 completed. Discharge summary attached.', time: '11:20', unread: false },
];

export const ALERT_GROUPS = ['today', 'yesterday'];

// The alerts of each group, in order, leaving out a group that has none.
export function groupAlerts(items) {
  return ALERT_GROUPS.map((group) => ({ group, items: items.filter((a) => a.group === group) })).filter((g) => g.items.length > 0);
}

// Local state changes for the preview (nothing is stored anywhere).
export const markAlertRead = (items, id) => items.map((a) => (a.id === id && a.unread ? { ...a, unread: false } : a));
export const markAllAlertsRead = (items) => items.map((a) => (a.unread ? { ...a, unread: false } : a));
export const unreadAlertCount = (items) => items.filter((a) => a.unread).length;
