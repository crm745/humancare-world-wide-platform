/* global describe, test, expect, __dirname */
// The eight services on Home and on All Services, the Air Ambulance choice, the two tiles that are only shown, and the
// layout that keeps every name readable.
const fs = require('fs');
const path = require('path');
const { HOME_SERVICES, AIR_OPTIONS, SERVICE_TILES } = require('../../data/mock');
const { isPublicRoute } = require('../authGuard');
const { COLUMNS, HOME_SIDE_PADDING, HOME_MAX_WIDTH, LABEL_SIZES, LONGEST_WORD_EM, gridFor } = require('../homeLayout');
const i18n = JSON.parse(fs.readFileSync(path.join(__dirname, '../../data/i18n.json'), 'utf8'));

const read = (relative) => fs.readFileSync(path.join(__dirname, relative), 'utf8');
const NL = String.fromCharCode(10);
const codeOf = (source) => source.split(NL).filter((l) => !l.trim().startsWith('//')).join(NL);
const home = codeOf(read('../../app/home.js'));
const grid = codeOf(read('../../components/home/ServicesGrid.js'));
const air = codeOf(read('../../app/air-ambulance.js'));
const all = codeOf(read('../../app/all-services.js'));

const ORDER = ['Air Ambulance', 'Teleconsultation', 'Home Healthcare Services', 'Ground Ambulance', 'Mortal Remains Transportation',
  'Corporate Medical Solutions', 'Marine Medical Safety', 'Medical Value Travel'];

describe('the eight top-level services, in the approved order', () => {
  test('exactly eight tiles', () => {
    expect(HOME_SERVICES).toHaveLength(8);
    expect(new Set(HOME_SERVICES.map((s) => s.key)).size).toBe(8);
  });
  test('Air Ambulance | Teleconsultation | Home Healthcare Services | Ground Ambulance | Mortal Remains Transportation | Corporate Medical Solutions | Marine Medical Safety | Medical Value Travel', () => {
    expect(HOME_SERVICES.map((s) => i18n.EN[s.title])).toEqual(ORDER);
    expect(HOME_SERVICES.map((s) => s.key)).toEqual(['air', 'tele', 'homecare', 'ground', 'mortal', 'corporate', 'marine', 'medvalue']);
  });
  test('Home draws this list, and a "More" tile as the ninth cell', () => {
    expect(home).toContain("import { HOME_SERVICES, SERVICE_LABELS } from '../data/mock';");
    expect(home).toContain('const HOME_TILES = HOME_SERVICES;');
    expect(home).toContain('services={HOME_TILES}');
    expect(grid).toContain("const items = [...services, { key: '__more', more: true }];");
    expect(grid).toContain('LayoutGrid');
    expect(grid).toContain("t('home_more')");
  });
  test('All Services draws exactly the same list, in the same order', () => {
    expect(all).toContain("import { HOME_SERVICES } from '../data/mock';");
    expect(all).toContain('HOME_SERVICES.map((s) => {');
    expect(all).not.toContain('SERVICE_TILES');
  });
  test('every title exists in all six languages, and the other five are translated', () => {
    for (const s of HOME_SERVICES) {
      for (const lang of Object.keys(i18n)) expect(i18n[lang][s.title]).toBeTruthy();
      for (const lang of ['HI', 'MR', 'GU', 'TE', 'AR']) expect(i18n[lang][s.title]).not.toBe(i18n.EN[s.title]);
    }
  });
});

describe('Air Ambulance is one tile that opens a choice, on Home and on All Services', () => {
  test('one Air Ambulance tile; Private Charter and Commercial Airlines are not top-level tiles', () => {
    expect(HOME_SERVICES.filter((s) => s.key === 'air')).toHaveLength(1);
    expect(HOME_SERVICES.some((s) => s.key === 'privatecharter' || s.key === 'commercialair')).toBe(false);
    expect(HOME_SERVICES[0].route).toBe('/air-ambulance');
  });
  test('Home and All Services both open a tile with its route, or with openService', () => {
    expect(home).toContain('const openTile = (s) => (s.route ? router.push(s.route) : openService(s.key));');
    expect(all).toContain('onPress={() => (s.route ? router.push(s.route) : openService(s.key))}');
  });
  test('the Air Ambulance card on All Services has its own subtitle, which exists in every language', () => {
    expect(HOME_SERVICES[0].sub).toBe('svc_air_sub');
    for (const lang of Object.keys(i18n)) expect(i18n[lang].svc_air_sub).toBeTruthy();
  });
  test('the choice has the two services, as the existing tiles (not copies)', () => {
    expect(AIR_OPTIONS.map((s) => s.key)).toEqual(['privatecharter', 'commercialair']);
    expect(AIR_OPTIONS[0]).toBe(SERVICE_TILES.find((s) => s.key === 'privatecharter'));
    expect(AIR_OPTIONS[1]).toBe(SERVICE_TILES.find((s) => s.key === 'commercialair'));
    expect(i18n.EN[AIR_OPTIONS[0].title]).toBe('Private Charter Air Ambulance Service');
    expect(i18n.EN[AIR_OPTIONS[1].title]).toBe('Commercial Airlines');
  });
  test('the screen: title Air Ambulance, a card for each option, each opening its existing service page', () => {
    expect(air).toContain("<TopBar title={t('svc_air')} />");
    expect(air).toContain('AIR_OPTIONS.map((s) => (');
    expect(air).toContain('onPress={() => openService(s.key)}');
    expect(air).toContain('<ServiceIcon serviceKey={s.key}');
    expect(air).toContain('accessibilityRole="button"');
    expect(i18n.EN.svc_air).toBe('Air Ambulance');
  });
  test('it starts nothing itself: no API call, no request, no new route', () => {
    expect(air).not.toMatch(/apiGet|apiPost|apiPatch|apiUpload|fetch\(|resetDraft|updateDraft/);
    expect(air).not.toContain('router.push');
  });
  test('it is a protected screen, a normal stack screen with the standard back button', () => {
    expect(isPublicRoute('/air-ambulance')).toBe(false);
    expect(air).toContain('<TopBar title');
    expect(air).not.toContain('onBack');
  });
  test('each option still goes to the service page it opened before', () => {
    expect(read('../../components/ServiceGrid.js')).toContain('router.push(`/service/${key}`)');
  });
});

describe('the services keep their navigation, Corporate Medical Solutions included', () => {
  test.each(['tele', 'homecare', 'ground', 'mortal', 'corporate', 'marine', 'medvalue'])('%s is the existing kind of tile, opened the way every service is', (key) => {
    const entry = HOME_SERVICES.find((s) => s.key === key);
    expect(entry).toBe(SERVICE_TILES.find((s) => s.key === key));
    expect(entry.placeholder).toBeUndefined();
    expect(entry.route).toBeUndefined(); // no route: it opens /service/<key>, then its request form
  });
  test('Corporate Medical Solutions is not a placeholder on either screen', () => {
    expect(HOME_SERVICES.find((s) => s.key === 'corporate').placeholder).toBeUndefined();
    expect(HOME_SERVICES.filter((s) => s.placeholder).map((s) => s.key)).not.toContain('corporate');
  });
  test('its service data and page are the ones that were there', () => {
    const services = JSON.parse(read('../../data/services.json'));
    expect(services.corporate.title).toBe('Corporate Medical Solutions');
    expect(read('../../components/ServiceGrid.js')).toContain('router.push(`/service/${key}`)');
  });
});

describe('Marine Medical Safety and Medical Value Travel are full services, with the standard flow', () => {
  const NEW = [['marine', 'Marine Medical Safety', 'IMG_AIR'], ['medvalue', 'Medical Value Travel', 'IMG_HOSPITAL']];
  const services = JSON.parse(read('../../data/services.json'));
  test.each(NEW)('%s is the existing kind of tile: no placeholder, no route, opened as /service/<key>', (key) => {
    const entry = HOME_SERVICES.find((s) => s.key === key);
    expect(entry).toBe(SERVICE_TILES.find((s) => s.key === key));
    expect(entry.placeholder).toBeUndefined();
    expect(entry.route).toBeUndefined();
  });
  test('no tile on Home or All Services is a placeholder any more', () => {
    expect(HOME_SERVICES.filter((s) => s.placeholder)).toEqual([]);
  });
  test.each(NEW)('%s has its service page: a title, a description, three figures and four things it includes', (key, title) => {
    const svc = services[key];
    expect(svc.title).toBe(title);
    expect(svc.desc.length).toBeGreaterThan(60);
    expect(svc.stats).toHaveLength(3);
    for (const st of svc.stats) { expect(st.value).toBeTruthy(); expect(st.label).toBeTruthy(); }
    expect(svc.features).toHaveLength(4);
  });
  test.each(NEW)('%s uses a picture the app already has', (key, title, img) => {
    expect(services[key].img).toBe(img);
    expect(read('../../data/images.js')).toContain(`  ${img}: require(`);
    expect(SERVICE_TILES.find((s) => s.key === key).img).toBe(img);
  });
  test('the service titles are unique, so a saved request finds its service again by its title', () => {
    const { serviceKeyFromTitle } = require('../requestShape');
    const titles = Object.values(services).map((s) => s.title);
    expect(new Set(titles).size).toBe(titles.length);
    expect(serviceKeyFromTitle('Marine Medical Safety')).toBe('marine');
    expect(serviceKeyFromTitle('Medical Value Travel')).toBe('medvalue');
  });
  test('the request is sent under the service\'s own name and key, like every other service', () => {
    const { requestService } = require('../../data/mock');
    expect(requestService({ service: 'marine' }, services)).toEqual({ title: 'Marine Medical Safety', key: 'marine' });
    expect(requestService({ service: 'medvalue' }, services)).toEqual({ title: 'Medical Value Travel', key: 'medvalue' });
  });
  test('it is the ordinary patient form: no care level, no airline mode, no deceased fields, no mobility or equipment', () => {
    const { needsAirlineMode, isMortal } = require('../../data/mock');
    const { draftForService, needsCareLevel } = require('../requestForm');
    for (const [key] of NEW) {
      expect(needsCareLevel(key)).toBe(false);
      expect(needsAirlineMode(key)).toBe(false);
      expect(isMortal(key)).toBe(false);
      const draft = draftForService({ service: 'air', care: ['x'], mobility: 'walking', equipOxygen: true }, key, { service: 'air', care: [], mobility: '', equipOxygen: false });
      expect(draft.service).toBe(key);
      expect(draft.mobility).toBe('');
      expect(draft.equipOxygen).toBe(false);
    }
  });
  test('the names, the subtitles and the filter labels exist in all six languages, and the others are translated', () => {
    for (const [key] of NEW) {
      const tile = SERVICE_TILES.find((s) => s.key === key);
      for (const lang of Object.keys(i18n)) { expect(i18n[lang][tile.title]).toBeTruthy(); expect(i18n[lang][tile.sub]).toBeTruthy(); }
      for (const lang of ['HI', 'MR', 'GU', 'TE', 'AR']) { expect(i18n[lang][tile.title]).not.toBe(i18n.EN[tile.title]); expect(i18n[lang][tile.sub]).not.toBe(i18n.EN[tile.sub]); }
    }
    expect(i18n.EN.svc_marine_sub).toBe('Care at Sea & Evacuation');
    expect(i18n.EN.svc_medvalue_sub).toBe('Treatment Abroad, Arranged');
  });
  test('they can be picked in the My Requests service filter, and show their own icon', () => {
    const { SERVICE_LABELS } = require('../../data/mock');
    expect(SERVICE_LABELS.marine).toBe('svc_marine');
    expect(SERVICE_LABELS.medvalue).toBe('svc_medvalue');
    const icons = read('../../components/home/ServiceIcon.js');
    for (const [key] of NEW) { expect(icons).toContain(`  ${key}: {`); expect(icons).toContain(`  ${key}: ['#`); }
  });
  test('there is still no screen or route of their own: they use the service page and the request form every service uses', () => {
    const appDir = path.join(__dirname, '../../app');
    const files = [];
    (function walk(d) { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) walk(p); else files.push(p); } })(appDir);
    expect(files.filter((f) => /marine|medvalue|medical-value/i.test(path.basename(f)))).toEqual([]);
  });
  test('the grid and the All Services list can still draw a placeholder tile (none is one now)', () => {
    expect(grid).toContain('if (s.placeholder) return <View');
    expect(all).toContain('if (s.placeholder) return <View');
  });
});

describe('the Home grid: ALWAYS three columns, at every width', () => {
  const WIDTHS = [320, 360, 375, 390, 412, 600];
  test.each(WIDTHS)('%ipx: three columns; the eight services and the More tile make three full rows of three', (w) => {
    const g = gridFor(w);
    expect(g.columns).toBe(3);
    expect(HOME_SERVICES.length + 1).toBe(9);
    expect(Math.ceil((HOME_SERVICES.length + 1) / g.columns)).toBe(3);
    expect((HOME_SERVICES.length + 1) % g.columns).toBe(0);
  });
  test('the column count never changes, at any width from 200 to 2000', () => {
    for (let w = 200; w <= 2000; w += 1) expect(gridFor(w).columns).toBe(COLUMNS);
    expect(COLUMNS).toBe(3);
  });
  test('there is no two-column layout, breakpoint or narrow-screen switch left in the code', () => {
    const layout = codeOf(read('../homeLayout.js'));
    expect(layout).not.toMatch(/NARROW|columnsFor|labelSizeFor|FOUR_COLUMN_MIN_CELL|WIDE_COLUMNS/);
    expect(grid).not.toMatch(/columnsFor|NARROW|columns === 2|columns: 2/);
    expect(grid).toContain('const { columns, gap, bleed, labelSize, lineHeight } = gridFor(width);');
    expect(grid).toContain('i += columns) rows.push(items.slice(i, i + columns));');
  });
  test.each(WIDTHS)('%ipx: the three tiles and their gaps fit the screen exactly, with no sideways scroll', (w) => {
    const g = gridFor(w);
    const content = Math.min(w, HOME_MAX_WIDTH);
    expect(g.cell * g.columns + g.gap * (g.columns - 1) + 2 * g.pad).toBeCloseTo(content, 5);
    expect(g.bleed).toBe(HOME_SIDE_PADDING - g.pad);
    expect(g.pad + g.bleed).toBe(HOME_SIDE_PADDING);
  });
  test('Home keeps its own spacing (18 padding, 8 gap) at every width, and does not reach into its padding', () => {
    for (const w of [320, 360, 375, 390, 412, 600, 720]) { expect(gridFor(w).pad).toBe(18); expect(gridFor(w).gap).toBe(8); expect(gridFor(w).bleed).toBe(0); }
  });
  test('a tile is never narrower than 85, so a name keeps a readable width', () => {
    for (let w = 320; w <= 1400; w += 1) expect(gridFor(w).cell).toBeGreaterThanOrEqual(85);
  });
  test('names stay readable: 10.5 as before where there is room, never below 9.5', () => {
    for (let w = 200; w <= 1400; w += 1) {
      const size = gridFor(w).labelSize;
      expect(LABEL_SIZES).toContain(size);
      expect(size).toBeGreaterThanOrEqual(9.5);
    }
    for (const w of [320, 360, 375, 390, 412, 600]) expect(gridFor(w).labelSize).toBe(10.5);
  });
  test('the size is never scaled down further than needed: the longest word fits the tile at the chosen size', () => {
    for (const w of [320, 360, 375, 390, 412, 600]) {
      const g = gridFor(w);
      expect(LONGEST_WORD_EM * g.labelSize).toBeLessThan(g.cell);
    }
  });
  test('the line height follows the size', () => {
    for (const w of [320, 360, 390, 412]) expect(gridFor(w).lineHeight).toBe(Math.round(gridFor(w).labelSize * 1.35));
  });
  test('odd inputs give the normal layout, not a broken one', () => {
    for (const w of [undefined, null, NaN, 0, -5]) expect(gridFor(w).columns).toBe(3);
  });
  test('the grid draws three columns with that gap, wraps a name onto up to three lines, and does not shrink text', () => {
    expect(grid).toContain("<View style={{ gap: 12, marginHorizontal: -bleed }}>");
    expect(grid).toContain("flexDirection: 'row', gap }}");
    expect(grid).toContain('fontSize: labelSize, lineHeight, color: NAVY, textAlign:');
    expect(grid).toContain('numberOfLines={3}');
    expect(grid).not.toContain('adjustsFontSizeToFit');
  });
  test('the last row is padded so tiles stay the same width', () => {
    expect(grid).toContain('row.length < columns && Array.from({ length: columns - row.length }');
  });
  test('the tiles keep their icon box, centred', () => {
    expect(grid).toContain('width: 48, height: 48, borderRadius: 14');
    expect(grid).toContain("alignItems: 'center', gap: 6");
    expect(grid).toContain("textAlign: 'center'");
  });
});

describe('what was left alone', () => {
  test('Home keeps its header, banner, active request card, SOS bar and bottom navigation', () => {
    for (const piece of ['<HomeHeader hasUnread={hasUnread}', '<BannerCarousel', '<ActiveRequestCard', '<ActiveRequestSkeleton', '<SosBar bottom={TAB_BAR + insets.bottom}', '<BottomNav />', '<Greeting']) {
      expect(home).toContain(piece);
    }
    expect(home).toContain("router.push({ pathname: '/request-tracking', params: { id: current.id } })");
  });
  test('All Services keeps its header and bottom navigation, and its card design (its SOS is the floating button now)', () => {
    expect(all).toContain("<TopBar title={t('filter_svc_all')} />");
    expect(all).not.toContain('SosBar');
    expect(all).toContain('<BottomNav />');
    expect(all).toContain("minHeight: 76, flexDirection: 'row', alignItems: 'center', gap: 14");
    expect(all).toContain("width: 54, height: 54, borderRadius: 14, backgroundColor: '#EDF2F9'");
    expect(all).toContain("borderColor: '#D6E2F2'");
  });
  test('the "More" tile (not a "View all services" link) opens All Services, which is a screen of its own', () => {
    expect(grid).not.toContain('home_view_all');
    expect(grid).toContain('s.more ? onViewAll() : onPressService(s)');
    expect(home).toContain("onViewAll={() => navReplace('/all-services')}");
  });
  test('"Select a Service" (used when changing the service of a request) is as it was', () => {
    expect(codeOf(read('../../components/ServiceGrid.js'))).toContain('SERVICE_TILES.map((s) => (');
  });
});
