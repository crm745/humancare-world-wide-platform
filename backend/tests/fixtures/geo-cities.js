// City fixtures for the Private Charter tests. Ids 1275339 ... 5881576 are real GeoNames ids,
// with the values from the official cities15000 dump; ids from 900000000 up are synthetic and
// exist only to show a case the real sample cannot (a UTC+14 zone, a small town, a historical
// place stored by mistake). Data: GeoNames (geonames.org), CC BY 4.0.
const IDS = {
  MUMBAI: 1275339,
  DUBAI: 292223,
  NEW_YORK: 5128581,
  WELLINGTON: 2179537,
  LOS_ANGELES: 5368361,
  ZURICH: 2657896,
  MUNICH: 2867714,
  AUCKLAND: 2193733,
  PAGO_PAGO: 5881576,
  HISTORICAL: 6949382, // Pittwater, PPLH: stored here only to prove the lookup refuses it too
  SUBDIVISION: 2658656, // Zürich (Kreis 11) / Seebach, PPLX: same, for a subdivision of a city
  KIRITIMATI: 900000001, // UTC+14
  MUMBWA: 900000002, // population 1,200: below the short-query floor
  NOT_IN_TABLE: 123456789,
  STALE_DATA: 999999999, // the mocked resolver throws "city_data_stale" for this one
};

const row = (geonameId, name, asciiName, admin1Name, countryCode, featureCode, population, timezone) => (
  { geonameId, name, asciiName, admin1Name, countryCode, featureCode, population, timezone }
);

const ROWS = [
  row(IDS.MUMBAI, 'Mumbai', 'Mumbai', 'Maharashtra', 'IN', 'PPLA', 12691836, 'Asia/Kolkata'),
  row(IDS.DUBAI, 'Dubai', 'Dubai', 'Dubai', 'AE', 'PPLA', 3790000, 'Asia/Dubai'),
  row(IDS.NEW_YORK, 'New York City', 'New York City', 'New York', 'US', 'PPL', 8804190, 'America/New_York'),
  row(IDS.WELLINGTON, 'Wellington', 'Wellington', 'Wellington Region', 'NZ', 'PPLC', 381900, 'Pacific/Auckland'),
  row(IDS.LOS_ANGELES, 'Los Angeles', 'Los Angeles', 'California', 'US', 'PPLA2', 3820914, 'America/Los_Angeles'),
  row(IDS.ZURICH, 'Zürich', 'Zuerich', 'Zurich', 'CH', 'PPLA', 415367, 'Europe/Zurich'),
  row(IDS.MUNICH, 'Munich', 'Munich', 'Bavaria', 'DE', 'PPLA', 1505005, 'Europe/Berlin'),
  row(IDS.AUCKLAND, 'Auckland', 'Auckland', null, 'NZ', 'PPLA', 1547200, 'Pacific/Auckland'),
  row(IDS.PAGO_PAGO, 'Pago Pago', 'Pago Pago', null, 'AS', 'PPLC', 11500, 'Pacific/Pago_Pago'),
  row(IDS.KIRITIMATI, 'Kiritimati Test', 'Kiritimati Test', null, 'KI', 'PPL', 5000, 'Pacific/Kiritimati'),
  row(IDS.MUMBWA, 'Mumbwa Test', 'Mumbwa Test', null, 'ZM', 'PPL', 1200, 'Africa/Lusaka'),
  row(4177703, 'Wellington', 'Wellington', 'Florida', 'US', 'PPL', 62560, 'America/New_York'),
];
const HISTORICAL_ROW = row(IDS.HISTORICAL, 'Pittwater', 'Pittwater', null, 'AU', 'PPLH', 63482, 'Australia/Sydney');
const SUBDIVISION_ROW = row(IDS.SUBDIVISION, 'Zürich (Kreis 11) / Seebach', 'Zuerich (Kreis 11) / Seebach', 'Zurich', 'CH', 'PPLX', 17851, 'Europe/Zurich');

// The other names the importer would have stored for some of them (translations, local spellings,
// other scripts, old names). Keyed by geoname id.
const ALTERNATE_NAMES = {
  [IDS.MUNICH]: ['München', 'Munchen', 'Muenchen', 'Monaco di Baviera', 'Mnichov', 'Мюнхен', '慕尼黑'],
  [IDS.MUMBAI]: ['Bombay', 'मुंबई'],
  [IDS.DUBAI]: ['دبي', 'Dubayy'],
  [IDS.NEW_YORK]: ['NYC', 'Nueva York', 'Nowy Jork'],
  [IDS.WELLINGTON]: ['Te Whanganui-a-Tara'],
  [4177703]: ['Wellington FL'],
};

module.exports = { IDS, ROWS, HISTORICAL_ROW, SUBDIVISION_ROW, ALTERNATE_NAMES };
