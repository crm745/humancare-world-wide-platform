/* global describe, test, expect, beforeEach, afterEach, jest, __dirname */
// The Tracking Details banner: its texts, its per-service config (with the icon fallback), the relative time (with a fake clock, and the
// one-minute refresh), the status colours and the spoken label. Made-up requests only.
const fs = require('fs');
const path = require('path');
const i18n = require('../../data/i18n.json');
const { translate } = require('../translate');
const B = require('../trackingBanner');
const { BANNER_SERVICES, BANNER_FALLBACK, bannerConfigFor } = require('../trackingBannerConfig');
const IM = require('../trackingBannerImages');
const { buildTrackingDetails } = require('../trackingDetailsView');

const LANGS = ['EN', 'HI', 'MR', 'GU', 'TE', 'AR'];
const t = (key, values) => translate(i18n, 'EN', key, values);
const read = (relative) => fs.readFileSync(path.join(__dirname, relative), 'utf8');

const ev = (stage, occurredAt) => ({ id: 1, caseId: 3, stage, note: 'a staff note', occurredAt });
const request = (extra) => ({
  id: 7, referenceNumber: 'REQ-1067', serviceType: 'Private Charter Air Ambulance Service', serviceKey: 'privatecharter', status: 'in_progress', reviewStatus: null,
  createdAt: '2026-11-13T12:07:00', origin: 'Mumbai, Maharashtra, India', destination: 'Delhi, Delhi, India', originCityName: 'Mumbai', destinationCityName: 'Delhi',
  case: { id: 3, status: 'in_progress', stageEvents: [ev('submitted', '2026-11-13T12:07:00'), ev('in_progress', '2026-11-15T01:15:00')], documents: [] }, ...extra,
});
const ground = (extra) => request({ serviceType: 'Ground Ambulance', serviceKey: 'ground', origin: 'Pune, Maharashtra, India', destination: 'Mumbai, Maharashtra, India', originCityName: null, destinationCityName: null, ...extra });
const home = (extra) => request({ serviceType: 'Home Healthcare Services', serviceKey: 'homecare', origin: 'Andheri West, Mumbai', destination: '', originCityName: null, destinationCityName: null, case: null, ...extra });

describe('the title and the subtitle', () => {
  test('with a route: "Mumbai → Delhi", and no second line: the service is named once, in the chip', () => {
    const d = buildTrackingDetails(request(), t);
    expect(B.bannerTexts(d)).toEqual({ title: 'Mumbai → Delhi', subtitle: '', showChipLabel: true });
    expect(d.chipLabel).toBe('Private Charter');
  });
  test('right to left: the arrow points the other way', () => {
    const d = buildTrackingDetails(request(), t);
    expect(B.bannerTexts(d, true).title).toBe('Mumbai ← Delhi');
  });
  test('without a route: the service name is the title (once; the chip keeps only its icon), and the area is below it', () => {
    const d = buildTrackingDetails(home(), t);
    expect(d.hasRoute).toBe(false);
    expect(B.bannerTexts(d)).toEqual({ title: 'Home Healthcare', subtitle: 'Andheri West, Mumbai', showChipLabel: false });
  });
  test('without a route and without an area: the service name alone, never a second name for it below', () => {
    const d = buildTrackingDetails(home({ origin: '' }), t);
    expect(B.bannerTexts(d)).toEqual({ title: 'Home Healthcare', subtitle: '', showChipLabel: false });
  });
  test('one city only is not a route: the service titles the banner and the city is the area', () => {
    const d = buildTrackingDetails(ground({ destination: '' }), t);
    expect(d.hasRoute).toBe(false);
    expect(B.bannerTexts(d).title).toBe('Ground Ambulance');
    expect(B.bannerTexts(d).subtitle).toBe('Pune, Maharashtra, India');
  });
  test('a service the config does not know: its full name is the title', () => {
    expect(B.bannerTexts({ hasRoute: false, from: '', to: '', shortName: '', serviceName: 'Some Service', area: '' })).toEqual({ title: 'Some Service', subtitle: '', showChipLabel: false });
  });
  test('a subtitle that only repeats the chip is left out (Ground Ambulance under a Ground Ambulance chip), with a route or without', () => {
    const d = buildTrackingDetails(ground(), t);
    expect(d.chipLabel).toBe('Ground Ambulance');
    expect(d.serviceName).toBe('Ground Ambulance');
    expect(B.bannerTexts(d)).toEqual({ title: 'Pune → Mumbai', subtitle: '', showChipLabel: true });
    expect(B.bannerTexts({ ...d, chipLabel: 'GROUND AMBULANCE ' }).subtitle).toBe('');
    // no route: the title is already the service, so the same name is not repeated below it either
    expect(B.bannerTexts({ hasRoute: false, from: '', to: '', shortName: 'Ground Ambulance', serviceName: 'Ground Ambulance', area: '', chipLabel: 'Ground Ambulance' }).subtitle).toBe('');
    // Private Charter's second line used to be its full name under an "Air Ambulance" chip: now there is none. An area under a service title is kept.
    expect(B.bannerTexts(buildTrackingDetails(request(), t)).subtitle).toBe('');
    expect(B.bannerTexts(buildTrackingDetails(home(), t)).subtitle).toBe('Andheri West, Mumbai');
  });
  test('very long city names are passed whole (the screen cuts them with an ellipsis after two lines)', () => {
    const long = 'Llanfairpwllgwyngyllgogerychwyrndrobwllllantysiliogogogoch';
    const d = buildTrackingDetails(request({ originCityName: long, destinationCityName: long }), t);
    expect(B.bannerTexts(d).title).toBe(`${long} → ${long}`);
  });
});

describe('the per-service config: chip label, chip icon', () => {
  const iconSource = read('../../components/home/ServiceIcon.js');
  const tileKeys = [...iconSource.matchAll(/^ {2}(\w+): \[COLORS|^ {2}(\w+): \['#/gm)].map((m) => m[1] || m[2]);
  test('every service that has an icon (the Home "Our Services" tiles) has an entry that uses that same icon', () => {
    expect(tileKeys.length).toBeGreaterThanOrEqual(10);
    for (const key of tileKeys) expect(BANNER_SERVICES[key]).toMatchObject({ icon: key });
    expect(Object.keys(BANNER_SERVICES).sort()).toEqual([...tileKeys].sort());
  });
  test('the approved chip labels', () => {
    const chip = (key) => t(bannerConfigFor(key).chipKey);
    expect(chip('privatecharter')).toBe('Air Ambulance');
    expect(chip('commercialair')).toBe('Medical Escort');
    expect(chip('ground')).toBe('Ground Ambulance');
    expect(chip('homecare')).toBe('Home Care');
    expect(chip('hospital')).toBe('Hospital');
    expect(chip('tele')).toBe('Teleconsult');
    expect(chip('mortal')).toBe('Repatriation');
    expect(chip('marine')).toBe('Marine');
    expect(chip('medvalue')).toBe('Medical Travel');
    expect(chip('corporate')).toBe('Corporate');
  });
  test('the config names no photo, circle or icon stand-in: just the chip', () => {
    for (const cfg of [...Object.values(BANNER_SERVICES), BANNER_FALLBACK]) expect(Object.keys(cfg).sort()).toEqual(['chipKey', 'icon', 'shortKey']);
  });
  test('the view carries the config for the request\'s own service', () => {
    const d = buildTrackingDetails(request(), t);
    expect(d).toMatchObject({ chipLabel: 'Private Charter', chipIcon: 'privatecharter', bannerImage: IM.BANNER_IMAGES.privatecharter, shortName: 'Private Charter' });
    const g = buildTrackingDetails(ground(), t);
    expect(g).toMatchObject({ chipLabel: 'Ground Ambulance', chipIcon: 'ground', bannerImage: IM.BANNER_IMAGES.ground, shortName: 'Ground Ambulance' });
    // an older record with only a title still finds its service (the app's own resolver), and so its chip
    const byTitle = buildTrackingDetails(ground({ serviceKey: '', serviceType: 'Ground Ambulance' }), t);
    expect(byTitle.chipIcon).toBe('ground');
  });
});

describe('the time of the last update', () => {
  // A fixed "now": 21 Nov 2026, 12:00 in the phone's own time zone.
  const NOW = new Date(2026, 10, 21, 12, 0, 0).getTime();
  const ago = (ms) => new Date(NOW - ms).toISOString();
  const text = (value) => B.relativeText(B.relativeParts(value, NOW), t);
  const S = 1000;
  const MIN = 60 * S;
  const HOUR = 60 * MIN;

  test('under a minute: "Just now" (a clock slightly ahead counts as just now too)', () => {
    expect(text(ago(0))).toBe('Just now');
    expect(text(ago(59 * S))).toBe('Just now');
    expect(text(ago(-30 * S))).toBe('Just now');
  });
  test('under an hour: "N min ago"', () => {
    expect(text(ago(60 * S))).toBe('1 min ago');
    expect(text(ago(2 * MIN + 10 * S))).toBe('2 min ago');
    expect(text(ago(59 * MIN + 59 * S))).toBe('59 min ago');
  });
  test('under a day: "N hr ago"', () => {
    expect(text(ago(HOUR))).toBe('1 hr ago');
    expect(text(ago(5 * HOUR + 40 * MIN))).toBe('5 hr ago');
    expect(text(ago(23 * HOUR + 59 * MIN))).toBe('23 hr ago');
  });
  test('the day before: "Yesterday"', () => {
    expect(text(new Date(2026, 10, 20, 8, 0).toISOString())).toBe('Yesterday');
    expect(text(new Date(2026, 10, 20, 0, 5).toISOString())).toBe('Yesterday');
  });
  test('older: "19 Nov", and with the year when it is another year', () => {
    expect(text(new Date(2026, 10, 19, 12, 53).toISOString())).toBe('19 Nov');
    expect(text(new Date(2026, 9, 5, 9, 0).toISOString())).toBe('05 Oct');
    expect(text(new Date(2025, 10, 19, 12, 53).toISOString())).toBe('19 Nov 2025');
  });
  test('nothing for a missing or invalid time', () => {
    for (const bad of [null, undefined, '', 'nonsense']) expect(B.relativeParts(bad, NOW)).toBeNull();
    expect(text(null)).toBe('');
  });
  test('the minute boundary moves the text: 59 s is "Just now", 60 s is "1 min ago"', () => {
    const at = ago(59 * S);
    expect(B.relativeText(B.relativeParts(at, NOW), t)).toBe('Just now');
    expect(B.relativeText(B.relativeParts(at, NOW + 1000), t)).toBe('1 min ago');
  });
  test('read aloud it is written out, with the right plural', () => {
    const say = (ms) => B.relativeSpoken(B.relativeParts(ago(ms), NOW), t);
    expect(say(10 * S)).toBe('just now');
    expect(say(MIN)).toBe('1 minute ago');
    expect(say(2 * MIN)).toBe('2 minutes ago');
    expect(say(HOUR)).toBe('1 hour ago');
    expect(say(3 * HOUR)).toBe('3 hours ago');
    expect(B.relativeSpoken(B.relativeParts(new Date(2026, 10, 20, 8, 0).toISOString(), NOW), t)).toBe('yesterday');
    expect(B.relativeSpoken(B.relativeParts(new Date(2026, 10, 19, 12, 53).toISOString(), NOW), t)).toBe('on 19 Nov');
    expect(B.relativeSpoken(null, t)).toBe('');
  });
  test('every language words every form', () => {
    for (const lang of LANGS) {
      const tl = (key, values) => translate(i18n, lang, key, values);
      for (const parts of [{ kind: 'now' }, { kind: 'min', n: 5 }, { kind: 'hr', n: 3 }, { kind: 'yesterday' }]) {
        expect(B.relativeText(parts, tl)).not.toMatch(/tb_|\{\{/);
        expect(B.relativeSpoken(parts, tl)).not.toMatch(/tb_|\{\{/);
        expect(B.relativeText(parts, tl)).not.toBe('');
      }
      expect(B.relativeText({ kind: 'min', n: 5 }, tl)).toContain('5');
    }
  });
});

describe('the one-minute refresh (a fake clock)', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test('it ticks once a minute, and not before', () => {
    const onTick = jest.fn();
    const stop = B.startMinuteTicker(onTick);
    jest.advanceTimersByTime(59 * 1000);
    expect(onTick).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1000);
    expect(onTick).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(3 * 60 * 1000);
    expect(onTick).toHaveBeenCalledTimes(4);
    stop();
  });
  test('stopping it (the screen closes) ends the ticking', () => {
    const onTick = jest.fn();
    const stop = B.startMinuteTicker(onTick);
    stop();
    jest.advanceTimersByTime(10 * 60 * 1000);
    expect(onTick).not.toHaveBeenCalled();
  });
  test('the text follows the clock: "Just now" becomes "1 min ago", then "2 min ago", minute by minute', () => {
    jest.setSystemTime(new Date(2026, 10, 21, 12, 0, 0));
    const at = new Date(2026, 10, 21, 11, 59, 30).toISOString(); // 30 s before the start
    const shown = [];
    const show = () => shown.push(B.relativeText(B.relativeParts(at, Date.now()), t));
    show();
    const stop = B.startMinuteTicker(show);
    jest.advanceTimersByTime(60 * 1000);
    jest.advanceTimersByTime(60 * 1000);
    stop();
    expect(shown).toEqual(['Just now', '1 min ago', '2 min ago']);
  });
  test('the screen starts it on mount and stops it on unmount', () => {
    const banner = read('../../components/tracking/TrackingBanner.js');
    expect(banner).toContain('useEffect(() => startMinuteTicker(() => setNow(Date.now())), []);'); // the effect returns the stopper
  });
});

describe('the drawn picture of every service', () => {
  const TABLE = {
    privatecharter: ['banner-private-charter', 168, 63, 2, 6, 0.55],
    commercialair: ['banner-medical-escort', 170, 54, 0, 10, 0.55],
    ground: ['banner-ground-ambulance', 146, 74, 4, 6, 0.55],
    hospital: ['banner-hospital', 124, 98, 8, 6, 0.64],
    homecare: ['banner-home-healthcare', 132, 98, 8, 6, 0.64],
    tele: ['banner-teleconsultation', 104, 106, 12, 6, 0.64],
    mortal: ['banner-repatriation', 100, 106, 14, 6, 0.64],
    marine: ['banner-marine', 156, 72, 2, 6, 0.55],
    medvalue: ['banner-medical-travel', 104, 102, 12, 6, 0.64],
    corporate: ['banner-corporate', 100, 104, 12, 6, 0.64],
  };
  test('every service in the table gets its image, size, position and text share', () => {
    expect(Object.keys(IM.BANNER_IMAGES).sort()).toEqual(Object.keys(TABLE).sort());
    for (const [key, [image, width, height, right, bottom, textMax]] of Object.entries(TABLE)) {
      expect(IM.bannerImageFor(key)).toEqual({ image, width, height, right, bottom, textMax });
    }
  });
  test('every service that has a chip has a picture, and the other way round', () => {
    expect(Object.keys(BANNER_SERVICES).sort()).toEqual(Object.keys(IM.BANNER_IMAGES).sort());
  });
  test('the request gets its own service\'s picture (the view carries it)', () => {
    expect(buildTrackingDetails(request(), t).bannerImage.image).toBe('banner-private-charter');
    expect(buildTrackingDetails(ground(), t).bannerImage.image).toBe('banner-ground-ambulance');
    expect(buildTrackingDetails(home(), t).bannerImage.image).toBe('banner-home-healthcare');
    expect(buildTrackingDetails(request({ serviceKey: 'commercialair_stretcher', serviceType: 'Commercial Airlines — Stretcher (CAS)' }), t).bannerImage.image).toBe('banner-medical-escort');
  });
  test('the generic "air" service has the Private Charter\'s picture; an unknown service gets none and no placeholder', () => {
    expect(IM.bannerImageFor('air')).toBe(IM.BANNER_IMAGES.privatecharter);
    for (const key of ['nonsense', '', undefined, null, 'constructor', 'toString', 42, {}]) expect(IM.bannerImageFor(key)).toBeNull();
    expect(IM.placeImage(null, 390)).toBeNull();
    const none = IM.textWidths({ image: null, cardWidth: 358, screenWidth: 390, title: 'Anything' });
    expect(none).toEqual({ title: Math.round(358 * 0.64), subtitle: Math.round(358 * 0.64) });
  });
  test('every picture file is bundled with the app, is the file\'s own shape, and is required by the banner', () => {
    const banner = read('../../components/tracking/TrackingBanner.js');
    for (const [, [image, width, height]] of Object.entries(TABLE)) {
      const file = path.join(__dirname, '../../../assets/images/banner', image + '.png');
      expect(fs.existsSync(file)).toBe(true);
      const bytes = fs.readFileSync(file);
      expect(bytes.readUInt32BE(16) / bytes.readUInt32BE(20)).toBeCloseTo(width / height, 1); // the table's size keeps the drawing's aspect ratio
      expect(banner).toContain(`'${image}': require('../../../assets/images/banner/${image}.png')`);
    }
  });
  test('wide pictures give the text 55% of the card, the others 64%', () => {
    for (const key of ['privatecharter', 'commercialair', 'ground', 'marine']) expect(IM.bannerImageFor(key).textMax).toBe(0.55);
    for (const key of ['hospital', 'homecare', 'tele', 'mortal', 'medvalue', 'corporate']) expect(IM.bannerImageFor(key).textMax).toBe(0.64);
  });
  test('on a screen narrower than 390 the picture and its offsets scale down in proportion; 390 and wider is the table', () => {
    const img = IM.bannerImageFor('privatecharter');
    expect(IM.scaleFor(390)).toBe(1);
    expect(IM.scaleFor(412)).toBe(1);
    expect(IM.scaleFor(320)).toBeCloseTo(320 / 390, 5);
    expect(IM.placeImage(img, 390)).toEqual({ width: 168, height: 63, right: 2, bottom: 6 });
    expect(IM.placeImage(img, 320)).toEqual({ width: 138, height: 52, right: 2, bottom: 5 });
    const small = IM.placeImage(img, 320);
    expect(small.width / small.height).toBeCloseTo(168 / 63, 1);
  });
  test('the text never reaches the picture, on any screen, for any service (the 80 px floor aside), and is never wider than its share', () => {
    for (const screen of [320, 340, 360, 375, 390, 412, 480]) {
      const card = screen - 32;
      for (const image of Object.values(IM.BANNER_IMAGES)) {
        const place = IM.placeImage(image, screen);
        for (const title of ['Pune \u2192 Mumbai', 'Corporate Medical Solutions']) {
          const w = IM.textWidths({ image, cardWidth: card, screenWidth: screen, title });
          const share = Math.round(card * image.textMax);
          expect(w.subtitle).toBeLessThanOrEqual(share);
          expect(w.title).toBeLessThanOrEqual(Math.max(80, share));
          const free = card - 16 - place.width - place.right - IM.TEXT_GAP;
          if (free >= 80) expect(w.subtitle).toBeLessThanOrEqual(free);
          if (free >= 80 && (title.length > IM.SHORT_TITLE || screen < 390)) expect(w.title).toBeLessThanOrEqual(free);
        }
      }
    }
  });
  test('at 390 a short title keeps its full share above a wide picture; a long title and the subtitle stop before it', () => {
    const img = IM.bannerImageFor('privatecharter');
    const w = IM.textWidths({ image: img, cardWidth: 358, screenWidth: 390, title: 'Mumbai \u2192 Delhi' });
    expect(w.title).toBe(Math.round(358 * 0.55)); // 197
    expect(w.subtitle).toBe(358 - 16 - 168 - 2 - 6); // 166
    expect(IM.textWidths({ image: img, cardWidth: 358, screenWidth: 390, title: 'Thiruvananthapuram \u2192 Visakhapatnam' }).title).toBe(166);
  });
});

describe('the blue part', () => {
  test('a 135-degree gradient #4450B8 -> #303A8F at 48% -> #222A6E, and a soft radial corner glow (white 18% to nothing)', () => {
    expect([...B.GRADIENT.colors]).toEqual(['#4450B8', '#303A8F', '#222A6E']);
    expect([...B.GRADIENT.locations]).toEqual([0, 0.48, 1]);
    expect(B.GRADIENT.start).toEqual({ x: 0, y: 0 });
    expect(B.GRADIENT.end).toEqual({ x: 1, y: 1 });
    expect(B.GLOW.opacity).toBe(0.18);
  });
  test('no photo, fade or shade is left in the banner code', () => {
    for (const name of ['FADE', 'SHADE', 'PHOTO_WIDTH', 'BLUE', 'TEXT_MAX', 'textMaxWidth']) expect(B[name]).toBeUndefined();
  });
});

describe('the status colours', () => {
  test('Submitted soft blue, In progress amber, Completed green, Cancelled grey (the shared mapping)', () => {
    expect(B.statusColorOf('submitted')).toBe('#303A8F');
    expect(B.statusColorOf('in_progress')).toBe('#8F4C08');
    expect(B.statusColorOf('completed')).toBe('#0B6564');
    expect(B.statusColorOf('cancelled')).toBe('#5B6B84');
  });
  test('anything else, an unknown status included (a Case-only status such as "scheduled"), reads as the quiet grey', () => {
    for (const status of ['', undefined, null, 'nonsense', 'scheduled']) expect(B.statusColorOf(status)).toBe('#5B6B84');
  });
  test('there is no second colour table in the banner', () => {
    expect(B.STATUS_COLOR).toBeUndefined();
    expect(fs.readFileSync(path.join(__dirname, '..', 'trackingBanner.js'), 'utf8')).not.toMatch(/#8F4C08|#0B6564/);
  });
  test('it is the colour of the app-wide status badge, so one status is one colour everywhere', () => {
    for (const status of ['in_progress', 'submitted', 'completed', 'cancelled']) {
      const d = buildTrackingDetails(ground({ status, case: null }), t);
      expect(d.status).toBe(status);
      expect(B.statusColorOf(d.status)).toBe(d.badge.fg);
    }
  });
});

describe('the spoken label of the card', () => {
  test('"Request REQ-1067, Mumbai to Delhi, Private Charter, status In Progress, updated 2 minutes ago"', () => {
    const d = buildTrackingDetails(request(), t);
    const label = B.bannerAccessibilityLabel({ ...d, status: d.badge.label, whenSpoken: '2 minutes ago' }, t);
    expect(label).toBe('Request REQ-1067, Mumbai to Delhi, Private Charter, status In Progress, updated 2 minutes ago');
  });
  test('without a route: the service name once, then the status and the time', () => {
    const d = buildTrackingDetails(home({ status: 'completed' }), t);
    expect(B.bannerAccessibilityLabel({ ...d, status: d.badge.label, whenSpoken: 'yesterday' }, t))
      .toBe('Request REQ-1067, Home Healthcare, status Completed, updated yesterday');
  });
  test('a missing time or status is left out, not read as "undefined"', () => {
    const label = B.bannerAccessibilityLabel({ reference: 'REQ-1', hasRoute: false, shortName: '', serviceName: 'Some Service' }, t);
    expect(label).toBe('Request REQ-1, Some Service');
  });
});

describe('the words', () => {
  const KEYS = Object.values(BANNER_SERVICES).flatMap((c) => [c.chipKey, c.shortKey]).concat([BANNER_FALLBACK.chipKey])
    .concat(['tb_status_label', 'tb_updated_label', 'tb_just_now', 'tb_min_ago', 'tb_hr_ago', 'tb_yesterday', 'tb_say_just_now', 'tb_say_min_one', 'tb_say_min_other',
      'tb_say_hr_one', 'tb_say_hr_other', 'tb_say_yesterday', 'tb_say_date', 'tb_a11y_request', 'tb_a11y_status', 'tb_a11y_updated']);
  test('every banner string exists, filled in, in all six languages', () => {
    expect(new Set(KEYS).size).toBe(37);
    for (const lang of LANGS) for (const key of KEYS) expect(typeof i18n[lang][key]).toBe('string');
    for (const lang of LANGS) for (const key of KEYS) expect(i18n[lang][key].trim()).not.toBe('');
  });
  test('the labels read as asked in English', () => {
    expect(i18n.EN.tb_status_label).toBe('Current status');
    expect(i18n.EN.tb_updated_label).toBe('Last updated');
  });
  test('the other languages are translated, not copied from English', () => {
    for (const lang of LANGS.filter((l) => l !== 'EN')) for (const key of ['tb_status_label', 'tb_updated_label', 'tb_just_now', 'tb_yesterday', 'tb_chip_charter', 'tb_chip_ground']) expect(i18n[lang][key]).not.toBe(i18n.EN[key]);
  });
});

describe('the loading skeleton has the banner\'s shape', () => {
  test('a tall dark block on top (158), a white row with two cells below, in one rounded card', () => {
    const skeleton = read('../../components/skeleton/screens.js');
    const body = skeleton.slice(skeleton.indexOf('export function TrackingSkeleton'));
    expect(body).toContain("minHeight: 158, padding: 16, backgroundColor: COLORS.primary");
    expect(body).toContain("borderRadius: 20, overflow: 'hidden'");
    expect(body).toContain("width: 1, alignSelf: 'stretch', backgroundColor: '#E4E9F2'");
    expect(body.match(/<SkeletonCircle size=\{38\}/g)).toHaveLength(2);
  });
});

describe('the end of the scroll clears the floating SOS button', () => {
  const { fabClearance, scrollPadFor } = require('../sos');
  const layout = read('../../components/layout.js');
  const screen = read('../../app/request-tracking.js');
  // what Body computes with clearSos: the shared rule, with a floor of 96
  const pad = ({ visible, insetBottom = 0, ownBase = 32 }) => scrollPadFor({ ownPad: Math.max(ownBase + insetBottom, 96), visible, clearance: fabClearance({ edge: 0, insetBottom }) });
  test('Tracking Details asks for it', () => {
    expect(screen).toContain('<Body clearSos refreshControl=');
  });
  test('Body: the larger of the screen\'s own padding (never under 96) and the SOS clearance, by the shared rule, only when asked', () => {
    expect(layout).toContain('export const SOS_MIN_PAD = 96;');
    expect(layout).toContain('scrollPadFor({ ownPad: Math.max(ownPadding, SOS_MIN_PAD), visible: sosVisible, clearance: fabClearance({ edge: bottomEdge, insetBottom: insets.bottom }) })');
    expect(layout).toContain(': ownPadding;'); // every other screen is untouched
    expect(layout).toContain('contentContainerStyle={{ paddingBottom }}');
  });
  test('with the button showing, the padding is at least 96 and at least the button\'s clearance, so the last row ends above it', () => {
    for (const insetBottom of [0, 16, 34]) {
      const p = pad({ visible: true, insetBottom });
      expect(p).toBeGreaterThanOrEqual(96);
      expect(p).toBeGreaterThanOrEqual(fabClearance({ edge: 0, insetBottom }));
      expect(p).toBe(Math.max(96, 32 + insetBottom, fabClearance({ edge: 0, insetBottom }))); // the larger, never the two added together
    }
  });
  test('without the button (signed out, a corporate account) the padding is still at least 96', () => {
    expect(pad({ visible: false })).toBe(96);
    expect(pad({ visible: false, insetBottom: 80 })).toBe(112);
  });
});

describe('the banner modules agree with each other (a name imported from one must be exported by it)', () => {
  // A missing export is not an error at import time: the name is just undefined, and the first call fails ("photoKeyFor is not a function"). So every named import
  // of the banner modules, in the code that uses them, is checked against what the module really exports.
  const MODULES = { trackingBanner: '../trackingBanner', trackingBannerConfig: '../trackingBannerConfig', trackingBannerImages: '../trackingBannerImages' };
  const CONSUMERS = ['../trackingDetailsView.js', '../../components/tracking/TrackingBanner.js', '../../components/tracking/TrackingDetails.js'];
  test('every named import of a banner module exists, as a function or a value, in that module', () => {
    let checked = 0;
    for (const file of CONSUMERS) {
      const source = read(file);
      for (const match of source.matchAll(/import\s*\{([^}]+)\}\s*from\s*'((?:\.\.?\/)+(?:lib\/)?(trackingBanner|trackingBannerConfig|trackingBannerImages))'/g)) {
        const mod = require(MODULES[match[3]]);
        for (const name of match[1].split(',').map((n) => n.trim().split(/\s+as\s+/)[0]).filter(Boolean)) {
          expect({ file, module: match[3], name, exported: mod[name] !== undefined }).toEqual({ file, module: match[3], name, exported: true });
          checked += 1;
        }
      }
    }
    expect(checked).toBe(13); // the scan really found the imports (1 + 1 in the view, 9 + 2 in the banner)
  });
  test('the removed photo helpers are not used anywhere any more', () => {
    for (const file of [...CONSUMERS, '../trackingBannerConfig.js', '../trackingBanner.js', '../trackingBannerImages.js']) expect(read(file)).not.toMatch(/photoKeyFor|photoKey\b/);
    expect(typeof require('../trackingBannerConfig').photoKeyFor).toBe('undefined');
  });
  test('building the tracking details works end to end for every service, each with its own picture', () => {
    for (const key of Object.keys(IM.BANNER_IMAGES)) {
      const d = buildTrackingDetails(request({ serviceKey: key, serviceType: key }), t);
      expect(d).not.toBeNull();
      expect(d.bannerImage === null || typeof d.bannerImage.image === 'string').toBe(true);
    }
    expect(buildTrackingDetails(request(), t).bannerImage).toBe(IM.BANNER_IMAGES.privatecharter);
  });
});
