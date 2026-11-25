/* global describe, test, expect */
// Where a notification leads: one mapping for a tap in the Notifications list and a tap on a push. Pure, nothing navigates.
const { notificationTarget, targetFromNotification, targetFromPushResponse } = require('../notificationLink');

const REQUEST = (id) => ({ pathname: '/request-details', params: { id: String(id) } });
const response = (data) => ({ actionIdentifier: 'expo.modules.notifications.actions.DEFAULT', notification: { request: { content: { data } } } });

describe('notificationTarget', () => {
  test.each(['request', 'case', 'quotation', 'payment'])('%s opens the request page by service request id', (screen) => {
    expect(notificationTarget({ screen, serviceRequestId: 42 })).toEqual(REQUEST(42));
  });

  test('home opens Home, with or without a request id', () => {
    expect(notificationTarget({ screen: 'home' })).toEqual({ pathname: '/home' });
    expect(notificationTarget({ screen: 'home', serviceRequestId: 42 })).toEqual({ pathname: '/home' });
  });

  test('the id may arrive as digits (a push delivers what the server sent)', () => {
    expect(notificationTarget({ screen: 'request', serviceRequestId: '17' })).toEqual(REQUEST(17));
  });

  test.each([[null], [undefined], [0], [-3], [1.5], ['abc'], [''], ['12abc'], ['-4'], ['1.5'], [NaN], [{}], [[7]], [true]])('an invalid service request id (%p) leads nowhere', (id) => {
    for (const screen of ['request', 'case', 'quotation', 'payment']) expect(notificationTarget({ screen, serviceRequestId: id })).toBeNull();
  });

  test('an unknown or missing screen leads nowhere (never a guessed route)', () => {
    for (const screen of [undefined, null, '', 'tickets', 'admin', '/login', 'request-details', '../home', 'Home', 42, {}]) {
      expect(notificationTarget({ screen, serviceRequestId: 42 })).toBeNull();
    }
    expect(notificationTarget()).toBeNull();
    expect(notificationTarget({})).toBeNull();
  });
});

describe('a tap in the Notifications list', () => {
  test('uses data.screen and the notification\'s serviceRequestId', () => {
    expect(targetFromNotification({ id: 1, kind: 'stage_update', data: { screen: 'request', entityType: 'service_request', entityId: 8 }, serviceRequestId: 8, caseId: 3 })).toEqual(REQUEST(8));
    expect(targetFromNotification({ id: 2, kind: 'quotation_ready', data: { screen: 'quotation', entityType: 'quotation', entityId: 5 }, serviceRequestId: 8, quotationId: 5 })).toEqual(REQUEST(8));
    expect(targetFromNotification({ id: 3, kind: 'payment_failed', data: { screen: 'payment', entityType: 'payment', entityId: 9 }, serviceRequestId: 8, quotationId: 5 })).toEqual(REQUEST(8));
    expect(targetFromNotification({ id: 4, kind: 'security_new_login', data: { screen: 'home' }, serviceRequestId: null })).toEqual({ pathname: '/home' });
  });

  test('a legacy notification (no data, no references) does not navigate', () => {
    expect(targetFromNotification({ id: 5, kind: 'stage_update', title: 'CASE-1 update', body: 'x', readAt: null, createdAt: '2026-01-01T00:00:00.000Z' })).toBeNull();
    expect(targetFromNotification({ id: 6, kind: 'system', data: null, serviceRequestId: null })).toBeNull();
    expect(targetFromNotification({ id: 7, kind: 'system', data: {}, serviceRequestId: 8 })).toBeNull();
    expect(targetFromNotification({ id: 8, kind: 'stage_update', data: { screen: 'request' }, serviceRequestId: null })).toBeNull(); // a link without its id
  });

  test('a malformed notification does not throw', () => {
    for (const bad of [null, undefined, 'x', 5, [], { data: 'case' }, { data: [1] }]) expect(targetFromNotification(bad)).toBeNull();
  });
});

describe('a tap on a push', () => {
  test('the pushed { screen, serviceRequestId } gives the same target as the list', () => {
    expect(targetFromPushResponse(response({ screen: 'request', serviceRequestId: 8 }))).toEqual(REQUEST(8));
    expect(targetFromPushResponse(response({ screen: 'quotation', serviceRequestId: 8 }))).toEqual(REQUEST(8));
    expect(targetFromPushResponse(response({ screen: 'home' }))).toEqual({ pathname: '/home' });
    expect(targetFromPushResponse(response({ screen: 'request', serviceRequestId: 8 })))
      .toEqual(targetFromNotification({ data: { screen: 'request' }, serviceRequestId: 8 }));
  });

  test('a push with no data (an older push) or unusable data does not navigate', () => {
    for (const data of [undefined, null, {}, 'request', [], { screen: 'request' }, { serviceRequestId: 8 }, { screen: 'nowhere', serviceRequestId: 8 }]) {
      expect(targetFromPushResponse(response(data))).toBeNull();
    }
    for (const bad of [null, undefined, {}, { notification: {} }, { notification: { request: {} } }, { notification: { request: { content: {} } } }]) {
      expect(targetFromPushResponse(bad)).toBeNull();
    }
  });

  test('only screen and serviceRequestId are read: a pushed url, path or route cannot choose where the app goes', () => {
    const t = targetFromPushResponse(response({ screen: 'request', serviceRequestId: 8, url: 'https://evil.example', route: '/admin', pathname: '/login', params: { id: '999' } }));
    expect(t).toEqual(REQUEST(8));
    expect(targetFromPushResponse(response({ screen: '/login', serviceRequestId: 8, url: 'myapp://login' }))).toBeNull();
    expect(targetFromPushResponse(response({ url: '/request-details?id=5' }))).toBeNull();
  });
});
