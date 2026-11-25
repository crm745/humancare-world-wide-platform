/* global describe, test, expect, jest, beforeEach, afterEach */
// The direct Expo push: what it sends, and that the only data it can carry is { screen, serviceRequestId }. No network: fetch is a stub.
const { sendExpoPush, safePushData } = require('../../src/integrations/push/expo-push.service');
const { pushDataFromNotification } = require('../../src/modules/notifications/notification-catalogue');

let savedFetch;
beforeEach(() => { savedFetch = global.fetch; global.fetch = jest.fn(async () => ({ ok: true })); });
afterEach(() => { global.fetch = savedFetch; });
const sent = () => JSON.parse(global.fetch.mock.calls[0][1].body);

describe('sendExpoPush', () => {
  test('without data the message is exactly what it always was', async () => {
    await sendExpoPush('ExponentPushToken[x]', { title: 'T', body: 'B' });
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch.mock.calls[0][0]).toBe('https://exp.host/--/api/v2/push/send');
    expect(sent()).toEqual({ to: 'ExponentPushToken[x]', title: 'T', body: 'B', sound: 'default' });
  });

  test('with safe navigation data it is added to the message', async () => {
    await sendExpoPush('ExponentPushToken[x]', { title: 'T', body: 'B', data: { screen: 'request', serviceRequestId: 8 } });
    expect(sent()).toEqual({ to: 'ExponentPushToken[x]', title: 'T', body: 'B', sound: 'default', data: { screen: 'request', serviceRequestId: 8 } });
  });

  test('anything else in data is dropped before it is sent', async () => {
    await sendExpoPush('ExponentPushToken[x]', {
      title: 'T', body: 'B',
      data: { screen: 'quotation', serviceRequestId: 8, patientName: 'Asha Rao', diagnosis: 'x', note: 'staff note', caseId: 3, url: 'https://evil.example', quotationId: 5 },
    });
    expect(sent().data).toEqual({ screen: 'quotation', serviceRequestId: 8 });
    expect(JSON.stringify(sent())).not.toMatch(/Asha|diagnosis|staff note|evil|caseId|quotationId/);
  });

  test.each([
    ['an unknown screen', { screen: 'admin', serviceRequestId: 8 }],
    ['a route instead of a screen', { screen: '/login', serviceRequestId: 8 }],
    ['a request screen with no id', { screen: 'request' }],
    ['a request screen with a bad id', { screen: 'request', serviceRequestId: '8' }],
    ['no screen', { serviceRequestId: 8 }],
    ['an empty object', {}],
    ['a string', 'request'],
    ['null', null],
  ])('%s sends no data at all', async (_name, data) => {
    await sendExpoPush('ExponentPushToken[x]', { title: 'T', body: 'B', data });
    expect(sent()).not.toHaveProperty('data');
  });

  test('home needs no request id', async () => {
    await sendExpoPush('ExponentPushToken[x]', { title: 'T', body: 'B', data: { screen: 'home', serviceRequestId: 99, extra: 1 } });
    expect(sent().data).toEqual({ screen: 'home' });
  });

  test('no token: nothing is sent; a failing fetch never throws (best effort)', async () => {
    await sendExpoPush(null, { title: 'T', body: 'B', data: { screen: 'home' } });
    await sendExpoPush(undefined, { title: 'T', body: 'B' });
    expect(global.fetch).not.toHaveBeenCalled();
    global.fetch = jest.fn(() => Promise.reject(new Error('network down')));
    await expect(sendExpoPush('ExponentPushToken[x]', { title: 'T', body: 'B', data: { screen: 'home' } })).resolves.toBeUndefined();
  });
});

describe('the data a notification gives its push', () => {
  test('screen and serviceRequestId from the stored notification, and only those', () => {
    const n = { id: 1, kind: 'stage_update', title: 't', body: 'b', caseId: 3, quotationId: 5, serviceRequestId: 8, data: { screen: 'request', entityType: 'service_request', entityId: 8 } };
    expect(pushDataFromNotification(n)).toEqual({ screen: 'request', serviceRequestId: 8 });
    expect(pushDataFromNotification({ ...n, data: { screen: 'quotation', entityType: 'quotation', entityId: 5 } })).toEqual({ screen: 'quotation', serviceRequestId: 8 });
    expect(pushDataFromNotification({ data: { screen: 'home' }, serviceRequestId: null })).toEqual({ screen: 'home' });
  });

  test('a notification with no deep link (a legacy one, or no data) gives no push data', () => {
    for (const n of [null, undefined, 'x', {}, { data: null }, { data: {} }, { data: { screen: 'request' } }, { data: { screen: 'request' }, serviceRequestId: null },
      { data: { screen: 'tickets' }, serviceRequestId: 8 }, { data: 'request', serviceRequestId: 8 }]) {
      expect(pushDataFromNotification(n)).toBeUndefined();
    }
  });

  test('safePushData applies the same rule to whatever a caller passes', () => {
    expect(safePushData({ screen: 'payment', serviceRequestId: 8, secret: 'x' })).toEqual({ screen: 'payment', serviceRequestId: 8 });
    expect(safePushData({ screen: 'payment' })).toBeUndefined();
    expect(safePushData(undefined)).toBeUndefined();
  });
});
