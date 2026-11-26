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
const home = codeOf(read('../../app/(tabs)/home.js'));
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
    expect(home).toContain("import { HOME_SERVICES } from '../../data/mock';");
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
  // Marine Medical Safety's page shows no figures: its "100+ Ports Covered", "21+ Years Experience" and "24/7 Tele-Medical Advice" were all removed because the official
  // website does not support them (the list stays, empty, because the page draws whatever list the service has). Medical Value Travel keeps its three.
  test.each(NEW)('%s has its service page: a title, a description, its figures and four things it includes', (key, title) => {
    const svc = services[key];
    expect(svc.title).toBe(title);
    expect(svc.desc.length).toBeGreaterThan(60);
    expect(svc.stats).toHaveLength(key === 'marine' ? 0 : 3);
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
    for (const piece of ['<HomeHeader hasUnread={hasUnread}', '<BannerCarousel', '<ActiveRequestsSection', '<SosBar bottom={TAB_BAR + insets.bottom}', '<BottomNav />', '<Greeting']) {
      expect(home).toContain(piece);
    }
    expect(home).toContain("router.push({ pathname: '/request-tracking', params: { id: item.rawId } })");
  });
  test('All Services keeps its header with a back button (it is not a tab: no bottom navigation), and its card design (its SOS is the floating button now)', () => {
    expect(all).toContain("<TopBar title={t('filter_svc_all')} />");
    expect(all).not.toContain('SosBar');
    expect(all).not.toContain('BottomNav');
    expect(all).toContain("minHeight: 76, flexDirection: 'row', alignItems: 'center', gap: 14");
    expect(all).toContain("width: 54, height: 54, borderRadius: 14, backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#E4E9F2'");
    expect(all).toContain("borderColor: '#D6E2F2'");
  });
  test('the "More" tile (not a "View all services" link) opens All Services, which is a screen of its own', () => {
    expect(grid).not.toContain('home_view_all');
    expect(grid).toContain('s.more ? onViewAll() : onPressService(s)');
    expect(home).toContain("onViewAll={() => router.push('/all-services')}"); // a screen above Home, not a tab: back returns to Home
  });
  test('"Select a Service" (used when changing the service of a request) is as it was', () => {
    expect(codeOf(read('../../components/ServiceGrid.js'))).toContain('SERVICE_TILES.map((s) => (');
  });
});

describe('the Mortal Remains icon is an upright tapered coffin with a centred cross, drawn by the shared ServiceIcon only', () => {
  const icons = read('../../components/home/ServiceIcon.js');
  const entry = icons.slice(icons.indexOf('  mortal: {'), icons.indexOf('  tele: {'));
  test('the coffin and the cross are in place of the old casket, hand and heart, inside the 24 box', () => {
    expect(entry).toContain("fill: 'M9.5 2h5L19 8.5 15.5 22h-7L5 8.5z'");
    expect(entry).toContain("d: 'M9.5 2h5L19 8.5 15.5 22h-7L5 8.5zM12 6.5V16M8.5 10h7'");
    expect(icons).not.toContain('HEART');
    expect(entry).not.toContain('M4 12.5h16'); // the horizontal casket is gone
    const nums = (entry.match(/[-\d.]+/g) || []).map(Number).filter((n) => n >= 0);
    expect(Math.max(...nums)).toBeLessThanOrEqual(24);
  });
  test('the cross is centred on the coffin (x = 12, the middle of the 24 box)', () => {
    expect(entry).toContain('M12 6.5V16'); // the upright of the cross
    expect(entry).toContain('M8.5 10h7'); // the arm: 8.5 + 7 / 2 = 12
  });
  test('the rendering, the stroke, the colour tones and every other icon are unchanged', () => {
    expect(icons).toContain('strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round"');
    expect(icons).toContain("mortal: ['#5B6B84', '#EEF1F6'],");
    expect(icons).toContain('viewBox="0 0 24 24"');
    for (const key of ['privatecharter', 'ground', 'hospital', 'homecare', 'commercialair', 'tele', 'marine', 'medvalue', 'corporate']) expect(icons).toContain(`  ${key}: {`);
  });
});

describe('one icon per service everywhere: Home\'s ServiceIcon is the only place a service icon is drawn', () => {
  const SRC = path.join(__dirname, '../..');
  const files = [];
  (function walk(d) { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) { if (f !== '__tests__') walk(p); } else if (p.endsWith('.js')) files.push(p); } })(SRC);
  const rel = (f) => path.relative(SRC, f).split(path.sep).join('/');
  const src = (f) => fs.readFileSync(f, 'utf8');
  test('the screens and cards that show a service draw it with ServiceIcon / ServiceIconTile', () => {
    const users = files.filter((f) => /import \{[^}]*\bServiceIcon(Tile)?\b[^}]*\} from '[^']*home\/ServiceIcon'|from '\.\/ServiceIcon'/.test(src(f))).map(rel).sort();
    expect(users).toEqual([
      'app/air-ambulance.js', 'app/all-services.js', 'app/request-details.js', 'components/home/ActiveRequestCard.js', 'components/home/ServicesGrid.js', 'components/request/RequestFrame.js',
      'components/request/ReviewParts.js', 'components/requests/RequestCard.js', 'components/tracking/TrackingBanner.js', 'components/tracking/TrackingRequestCard.js',
    ]);
  });
  test('no other file draws service icon shapes of its own (only ServiceIcon.js and the brand marks of the social buttons have SVG paths)', () => {
    const withPaths = files.filter((f) => /<Path\b/.test(src(f))).map(rel).sort();
    expect(withPaths).toEqual(['components/SocialMarks.js', 'components/home/ServiceIcon.js']);
  });
  test('no file imports a Lucide icon in place of a service icon: no coffin-like, hand-heart, plane, ambulance or hospital icons outside the notifications categories', () => {
    const lucide = /import \{([^}]*)\} from 'lucide-react-native'/;
    const SERVICE_LIKE = ['HandHeart', 'Skull', 'Flower', 'Flower2', 'Cross', 'Ambulance', 'Plane', 'PlaneTakeoff', 'Hospital', 'Ship', 'Stethoscope', 'HeartPulse', 'Heart'];
    const hits = [];
    for (const f of files) {
      const m = lucide.exec(src(f));
      if (!m) continue;
      for (const name of m[1].split(',').map((x) => x.trim().split(/\s+as\s+/)[0])) if (SERVICE_LIKE.includes(name)) hits.push(`${rel(f)}:${name}`);
    }
    expect(hits.sort()).toEqual(['app/notifications.js:Hospital', 'app/notifications.js:Plane']); // notification categories (flight, hospital), not services
  });
  test('the old hand-and-heart Mortal Remains drawing is gone everywhere', () => {
    for (const f of files) expect({ file: rel(f), old: /M19 14c1\.49|M12 5 9\.04|\bHEART\b/.test(src(f)) }).toEqual({ file: rel(f), old: false });
  });
  test('every service key the app can show has an icon, and the tracking banner chip uses the same one', () => {
    const icons = src(path.join(SRC, 'components/home/ServiceIcon.js'));
    const keys = [...icons.slice(icons.indexOf('const PATHS')).matchAll(/^ {2}(\w+): \{/gm)].map((m) => m[1]).sort();
    expect(keys).toEqual(['commercialair', 'corporate', 'ground', 'homecare', 'hospital', 'marine', 'medvalue', 'mortal', 'privatecharter', 'tele']);
    const banner = src(path.join(SRC, 'lib/trackingBannerConfig.js'));
    expect(banner).toContain("mortal: Object.freeze({ chipKey: 'tb_chip_mortal', shortKey: 'tb_short_mortal', icon: 'mortal' })");
  });
});

describe('every service icon has the Home look: navy, a soft navy fill, a white tile with a thin line', () => {
  const SRC = path.join(__dirname, '../..');
  const src = (f) => fs.readFileSync(path.join(SRC, f), 'utf8');
  const icons = src('components/home/ServiceIcon.js');
  test('the one look is defined once, and ServiceIcon / ServiceIconTile use it with no colour passed in', () => {
    expect(icons).toContain("SERVICE_LOOK = Object.freeze({ color: '#0D2340', fill: '#0D2340', fillOpacity: 0.12, tile: '#FFFFFF', line: '#E4E9F2' })");
    expect(icons).toContain('export function ServiceIconTile({ serviceKey, size = 44, radius = 14 })');
    expect(icons).toContain("backgroundColor: SERVICE_LOOK.tile, borderWidth: 1, borderColor: SERVICE_LOOK.line");
    expect(icons).not.toContain('SERVICE_TONE[key]'); // no per-service colour is read any more
  });
  test('no caller overrides the colour of a service icon with anything but navy', () => {
    const files = ['app/air-ambulance.js', 'app/all-services.js', 'app/request-details.js', 'components/home/ServicesGrid.js', 'components/request/ReviewParts.js', 'components/requests/RequestCard.js', 'components/tracking/TrackingBanner.js'];
    for (const f of files) {
      for (const m of src(f).matchAll(/<ServiceIcon [^>]*>/g)) expect({ f, tag: m[0], navy: /color=\{(NAVY|C\.navy)\}/.test(m[0]) && /fill=\{(NAVY|C\.navy)\}/.test(m[0]) && /fillOpacity=\{0\.12\}/.test(m[0]) }).toMatchObject({ navy: true });
    }
  });
  test('the tile callers (the request form header, the Active and Tracking cards) pass no colours; only a size and a radius', () => {
    for (const f of ['components/request/RequestFrame.js', 'components/home/ActiveRequestCard.js', 'components/tracking/TrackingRequestCard.js']) {
      for (const m of src(f).matchAll(/<ServiceIconTile [^>]*\/>/g)) expect({ f, tag: m[0], overrides: /tint=|color=|fill=|fillOpacity=/.test(m[0]) }).toMatchObject({ overrides: false });
    }
  });
  test('the service-list tiles (All Services, service page) are white with the same thin line as Home, not a grey-blue block', () => {
    for (const f of ['app/all-services.js', 'app/air-ambulance.js']) { expect(src(f)).not.toContain('#EDF2F9'); expect(src(f)).toContain("backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#E4E9F2'"); }
  });
});

describe('changing the service from inside the request form: picking a service goes straight back to the form', () => {
  const grid = read('../../components/ServiceGrid.js');
  test('useOpenService: while changingService it keeps the draft for the new service and returns to the open form; otherwise it opens the service page', () => {
    expect(grid).toContain('export function useOpenService()');
    expect(grid).toContain('const { draft, resetDraft } = useApp();');
    expect(grid).toContain('if (draft.changingService) {');
    expect(grid).toContain('resetDraft(key);');
    expect(grid).toContain("router.dismissTo('/request/step1');");
    expect(grid).toContain('openService(key);');
    expect(grid.indexOf("router.dismissTo('/request/step1')")).toBeLessThan(grid.lastIndexOf('openService(key);'));
  });
  test('All Services and the Air Ambulance choice both use it, so the pick works the same from either', () => {
    for (const file of ['../../app/all-services.js', '../../app/air-ambulance.js']) {
      const src = read(file);
      expect(src).toContain("import { useOpenService } from '../components/ServiceGrid';");
      expect(src).toContain('const openService = useOpenService();');
    }
  });
  test('it is the same swap the service page does (resetDraft + dismissTo the form), and the form ends the swap when it is in front again', () => {
    const page = read('../../app/service/[key].js');
    expect(page).toContain("if (swapping) router.dismissTo('/request/step1');");
    expect(read('../../components/request/RequestFrame.js')).toContain('updateDraft({ changingService: false });');
  });
});
