/* global describe, test, expect, __dirname */
// A service is named ONCE wherever a patient sees it: the Tracking Details banner (chip + title + second line), Request Details, My Requests cards, the Home active-request card, the older tracking header.
// The bug: the same request showed "Medical Escort" (chip) over "Commercial Airlines" (second line). Transport variants ("— Stretcher (CAS)", "— Within India") and the stored "Medical Escort (...)" wrapper are
// information (their own rows), never a second service name. All eight services, in every language; made-up requests only; no device, no network.
const fs = require('fs');
const path = require('path');
const i18n = require('../../data/i18n.json');
const { translate } = require('../translate');
const B = require('../trackingBanner');
const { buildTrackingDetails } = require('../trackingDetailsView');
const { baseServiceName } = require('../requestDetailsView');
const { cardView } = require('../myRequestsView');
const { storedServiceName, toListItem } = require('../requestShape');
const { BANNER_SERVICES } = require('../trackingBannerConfig');

const LANGS = ['EN', 'HI', 'MR', 'GU', 'TE', 'AR'];
const tFor = (lang) => (key, values) => translate(i18n, lang, key, values);
const read = (rel) => fs.readFileSync(path.join(__dirname, '..', '..', rel), 'utf8');

// [stored serviceType, serviceKey, canonical English name]
const SERVICES = [
  ['Private Charter Air Ambulance Service', 'privatecharter', 'Private Charter Air Ambulance Service'],
  ['Medical Escort (Commercial Airlines) — Stretcher (CAS)', 'commercialair_stretcher', 'Commercial Airlines'],
  ['Medical Escort (Commercial Airlines) — Wheelchair (CAW)', 'commercialair_wheelchair', 'Commercial Airlines'],
  ['Tele Consultation & House Call', 'tele', null],
  ['Home Healthcare Services', 'homecare', null],
  ['Ground Ambulance', 'ground', 'Ground Ambulance'],
  ['Mortal Remains Transportation — Within India', 'mortal_domestic', null],
  ['Corporate Medical Solutions', 'corporate', null],
  ['Marine Medical Safety', 'marine', null],
  ['Medical Value Travel', 'medvalue', null],
];
const request = ([serviceType, serviceKey], extra) => ({
  id: 7, referenceNumber: 'REQ-1187', serviceType, serviceKey, status: 'submitted', reviewStatus: null, createdAt: '2026-11-23T12:30:00',
  origin: 'Goa, Goa, India', destination: 'Mumbai, Maharashtra, India', originCityName: 'Goa', destinationCityName: 'Mumbai', case: null, ...extra,
});
const noRoute = (s) => request(s, { origin: 'Andheri West, Mumbai', destination: '', originCityName: null, destinationCityName: null });

// Every word group that names the same service. If two different ones of these are on the banner at once, the service is named twice.
const NAMES_OF = {
  privatecharter: ['Private Charter', 'Air Ambulance', 'Private Charter Air Ambulance Service'],
  commercialair: ['Commercial Airlines', 'Medical Escort'],
  ground: ['Ground Ambulance'],
  homecare: ['Home Healthcare', 'Home Care', 'Home Healthcare Services'],
  tele: ['Teleconsultation', 'Teleconsult', 'Tele Consultation & House Call'],
  mortal: ['Mortal Remains', 'Repatriation', 'Mortal Remains Transportation'],
  corporate: ['Corporate Medical Solutions', 'Corporate'],
  marine: ['Marine Medical Safety', 'Marine'],
  medvalue: ['Medical Value Travel', 'Medical Travel'],
};

describe('the Tracking Details banner names the service once (the reported bug), for every service', () => {
  test('the reported request: Commercial Airlines is NOT also "Medical Escort"; the route is the title, the chip has the name, there is no second line', () => {
    const d = buildTrackingDetails(request(SERVICES[1]), tFor('EN'));
    expect(d.chipLabel).toBe('Commercial Airlines');
    expect(B.bannerTexts(d)).toEqual({ title: 'Goa → Mumbai', subtitle: '', showChipLabel: true });
    const shown = [d.chipLabel, B.bannerTexts(d).title, B.bannerTexts(d).subtitle].join(' | ');
    expect(shown).not.toMatch(/Medical Escort/);
    expect(shown.match(/Commercial Airlines/g)).toHaveLength(1);
  });
  test.each(SERVICES.map((s) => [s[1], s]))('%s: with a route, exactly one service name is on the banner (chip) and the second line is empty', (_key, s) => {
    const d = buildTrackingDetails(request(s), tFor('EN'));
    const texts = B.bannerTexts(d);
    expect(texts.subtitle).toBe('');
    expect(texts.title).toBe('Goa → Mumbai');
    expect(texts.showChipLabel).toBe(true);
    expect(d.chipLabel.trim()).not.toBe('');
  });
  test.each(SERVICES.map((s) => [s[1], s]))('%s: without a route the title is the service name, the chip label is hidden (icon only) and the second line is the area or nothing', (_key, s) => {
    const d = buildTrackingDetails(noRoute(s), tFor('EN'));
    const texts = B.bannerTexts(d);
    expect(texts.showChipLabel).toBe(false);
    expect(texts.title).toBe(d.shortName || d.serviceName);
    for (const names of Object.values(NAMES_OF)) {
      // the second line is never any wording of a service
      expect(names.some((n) => texts.subtitle.toLowerCase() === n.toLowerCase())).toBe(false);
    }
  });
  test('the chip is always the service\'s short name (the same words as the no-route title), in every language, for every service the banner knows', () => {
    for (const lang of LANGS) {
      const tr = tFor(lang);
      for (const [key, config] of Object.entries(BANNER_SERVICES)) {
        const d = buildTrackingDetails({ id: 1, referenceNumber: 'R', serviceType: 'x', serviceKey: key, status: 'submitted', createdAt: '2026-11-23T12:30:00', origin: 'A, B', destination: 'C, D', originCityName: 'A', destinationCityName: 'C' }, tr);
        expect({ lang, key, chip: d.chipLabel }).toEqual({ lang, key, chip: tr(config.shortKey) });
      }
    }
  });
  test('the spoken label names the service once', () => {
    const tr = tFor('EN');
    for (const s of SERVICES) {
      for (const make of [request, noRoute]) {
        const d = buildTrackingDetails(make(s), tr);
        const label = B.bannerAccessibilityLabel({ ...d, status: d.badge.label, whenSpoken: 'now' }, tr);
        expect(label).not.toMatch(/Medical Escort/);
        const spoken = label.split(', ').filter((part) => Object.values(NAMES_OF).some((names) => names.some((n) => part === n)));
        expect({ s: s[1], spoken }).toEqual({ s: s[1], spoken: [d.shortName || d.serviceName] });
      }
    }
  });
  test('the banner view hides the chip label only through showChipLabel', () => {
    const banner = read('components/tracking/TrackingBanner.js');
    expect(banner).toContain('{texts.showChipLabel ? <Text');
    expect(banner).toContain('{d.chipLabel}');
  });
});

describe('one canonical name on every other screen: no variant, no "Medical Escort (...)" wrapper', () => {
  test('storedServiceName', () => {
    expect(storedServiceName('Medical Escort (Commercial Airlines) — Stretcher (CAS)')).toBe('Commercial Airlines');
    expect(storedServiceName('Medical Escort (Commercial Airlines) — Wheelchair (CAW)')).toBe('Commercial Airlines');
    expect(storedServiceName('Mortal Remains Transportation — Within India')).toBe('Mortal Remains Transportation');
    expect(storedServiceName('Ground Ambulance')).toBe('Ground Ambulance');
    expect(storedServiceName(null)).toBe('');
    expect(storedServiceName(undefined)).toBe('');
  });
  test.each(SERVICES.map((s) => [s[1], s]))('%s: Request Details, My Requests and the older tracking header all give the same name, without " — " or a wrapper', (_key, s) => {
    for (const lang of LANGS) {
      const tr = tFor(lang);
      const details = baseServiceName(request(s), tr);
      const card = cardView(toListItem(request(s)), tr).name;
      for (const name of [details, card]) {
        expect({ lang, name: String(name) }).toEqual({ lang, name: String(name).replace(/ — .*/, '') });
        if (lang === 'EN') expect(name).not.toMatch(/Medical Escort|Stretcher|Wheelchair|Within India|International/);
      }
      expect({ lang, same: card === details }).toEqual({ lang, same: true });
    }
  });
  test('an unknown stored name still loses its variant and wrapper (it is shown as the name, once)', () => {
    expect(storedServiceName('Medical Escort (Some Airline) — Stretcher (CAS)')).toBe('Some Airline');
    expect(storedServiceName('Other Service — Variant')).toBe('Other Service');
    expect(storedServiceName('  Ground Ambulance  ')).toBe('Ground Ambulance');
  });
  test('Home\'s active-request card and the older tracking header use that one mapping (not the raw stored name)', () => {
    const home = read('app/home.js');
    expect(home).toContain('homeActiveSection(requests.map(toListItem))'); // the card's name comes from lib/activeRequests.js nameAndVariant (one name, once)
    expect(home).not.toMatch(/serviceName:[^\n]*current\.serviceType/);
    const tracking = read('app/tracking.js');
    expect(tracking).toContain('{item.referenceNumber} · {baseServiceName(item, t)}');
    expect(tracking).toContain("label={t('lbl_service')} value={baseServiceName(item, t)}");
    expect(tracking).not.toMatch(/\{item\.serviceType\}/);
    expect(tracking).not.toMatch(/value=\{item\.serviceType\}/);
  });
  test('the variants stay where they belong: Request Details has its own Travel type / Transfer type rows', () => {
    const view = read('lib/requestDetailsView.js');
    expect(view).toContain('rd_travel_');
    expect(view).toContain('rd_transfer_');
  });
});
