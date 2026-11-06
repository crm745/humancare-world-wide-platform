# GeoNames city dataset (Private Charter origin and destination)

Private Charter requests name their origin and destination as a city picked from a list. The list,
and the server-side check of the pick, use a **local copy of the GeoNames populated places** in two
tables, `geonames_cities` and `geonames_city_names`. There is no GeoNames account, no API call and no
network dependency while the app is running.

## Licence and credit (required)

The data is from [GeoNames](https://www.geonames.org), licensed
[Creative Commons Attribution 4.0](https://creativecommons.org/licenses/by/4.0/).

- Credit GeoNames wherever the city list is shown. `GET /geo/cities` returns the exact credit in its
  `attribution` field (`text`, `url`, `license`); the app should display it near the city picker (or
  on an About / Data sources screen).
- The data here is **modified**: only populated places (feature class `P`) are kept, historical,
  abandoned, destroyed places and subdivisions of cities are left out, the columns are reduced to id,
  name, ASCII name, region name, country code, feature code, population and timezone, and the other
  names of a place are cleaned (see below). Say so if you republish it.
- GeoNames provides the data "as is", without warranty of accuracy, timeliness or completeness.

## What the app does with it

| | |
|---|---|
| Search | `GET /geo/cities?q=...` (patient login, 60 requests a minute per account, 2 to 80 characters). Prefix match on the city's name, its plain-ASCII name or any **other name** (translations, local spellings in other scripts, old names), ignoring case and accents, biggest places first. Queries of 3 characters or fewer only match places of 5,000+ people. |
| Result | Always the **canonical** city: `{ geonameId, name, label, countryCode }`. Typing "München", "Munchen", "Мюнхен" or "慕尼黑" returns Munich, `2867714`, "Munich, Bavaria, Germany". The name that matched is never returned. |
| Request | The form sends `origin: { "geonameId": 2867714 }` and the same for `destination`, nothing else. |
| Verify | The server looks the id up here. It stores the city name, country code and (origin) timezone **from this table**, and builds the readable `origin` / `destination` text. |
| Date | The preferred date may not be earlier than today's date **in the origin city's timezone**. |
| Fail closed | An unknown, historical or subdivision id is a 400. An empty table, or records not refreshed within 180 days, is a 503 (`city_data_not_loaded` / `city_data_stale`): the request is not saved. |

### Which places count as a city

Every populated place (feature class `P`) **except**:

- `PPLH` historical place, `PPLCH` historical capital, `PPLQ` abandoned place, `PPLW` destroyed place;
- `PPLX` **section of a populated place**: a district or neighbourhood inside a city ("Zürich
  (Kreis 3)"). The picker is for the city or town itself. The importer skips these and removes any
  that an earlier import had stored; the lookup refuses them too.

Kept, among others: `PPL` city/town/village, `PPLA` to `PPLA5` administrative seats, `PPLC` capital,
`PPLG` seat of government, `PPLL` locality, `PPLF` farm village, `PPLR` religious community, `PPLS`,
and `STLMT` (GeoNames' code for an **Israeli settlement**: 225 places in the full file, kept because they are
classed as populated places; say if that should change). Names and meanings: <https://www.geonames.org/export/codes.html>.

### Other names

The importer reads each place's other names from the dump's own `alternatenames` column (the same
data as the separate `alternateNamesV2` file, already inside the file that is imported, so there is
no second download). Per place it keeps up to 150 names and leaves out: links, Wikidata ids, names of
only digits or punctuation, names of 1 character or over 200, repeats, repeats that differ only by
case or accents, and the place's own name and plain-ASCII name. Airport-code and nickname spellings
("NYC", "DXB") are kept.

By default the other names are kept for places **with a known population** (`--alt-min-population 1`).
In the full dump about 4.5 million of the 5 million places have no population recorded (mostly
hamlets) and carry 4.8 million of the 5.9 million other names; their own name and plain-ASCII name
stay searchable either way. `--alt-min-population 0` keeps everything (about six times as many
names; not measured, expect a larger table and a longer import).

## Import or update the data

Needs Node and the project's `backend` folder. Download over **HTTPS** from
`https://download.geonames.org/export/dump/` into a new, empty folder (treat downloaded files as
untrusted input: do not run anything from that folder).

```
allCountries.zip        all features; the importer keeps only the populated places
                        (403 MB zipped, 1.7 GB unzipped, 13.5 million lines)
cities500.zip, cities1000.zip, cities5000.zip, cities15000.zip
                        smaller files with a population floor, same format (not "all populated places")
admin1CodesASCII.txt    region names (small)
```

1. Unzip, so you have `allCountries.txt` (or a `citiesNNNN.txt`) and `admin1CodesASCII.txt`. (On
   Windows: `Expand-Archive`, or .NET `ZipFile.ExtractToDirectory`; Git Bash's `tar` cannot read zip.)
2. **Dry run** (writes nothing, shows what would be kept and skipped):
   ```
   node scripts/import-geonames.js --file <dir>/allCountries.txt --admin1 <dir>/admin1CodesASCII.txt --env-file .env --dry-run
   ```
   The output names the target database. Check it is the one you mean.
3. Back up the database (or at least the two `geonames_` tables).
4. **Import.** It only runs when you repeat the database name from the output:
   ```
   node scripts/import-geonames.js --file <dir>/allCountries.txt --admin1 <dir>/admin1CodesASCII.txt --env-file .env --confirm-database <database name>
   ```
   Safe to run again: records are updated (not duplicated) and stamped with this run's time, and a
   city's other names are replaced by the ones in the file. A city the file now lists as
   historical, abandoned or a subdivision is removed at once (its other names go with it). A city
   that has vanished from the file is left alone and stops being accepted 180 days after the last
   import that saw it.
5. Check: `node scripts/geonames-status.js --env-file .env` (exit code 0), and `GET /geo/cities?q=mün`
   returns Munich with the `attribution` block.

### Measured on the full `allCountries` file

Run on a separate scratch MySQL 26.7 instance (same binary as the main server, `innodb_buffer_pool_size`
128 MB, the same as the default of the main server), Windows, files on local disk, with some other
test runs happening at the same time:

| | |
|---|---|
| Lines in the file | 13,483,617 |
| Kept as cities | **5,001,450** (skipped: 8,248,862 not populated places, 171,373 PPLX, 61,932 historical or abandoned) |
| Other names stored | **1,019,309** (1,020,126 offered; 817 collapsed because MySQL treats them as the same name, e.g. ß and ss) |
| Import time | **948 s (15.8 min)** |
| Importer memory (peak resident) | **544 MB** (it streams the file; it does not grow with the file) |
| MySQL memory (peak working set) | 561 MB |
| Table sizes | `geonames_cities` 606 MB data + 446 MB indexes; `geonames_city_names` 56 MB + 47 MB: about **1.2 GB** |
| Data folder on disk | about 1.9 GB (includes MySQL's logs) |
| Distinct timezones | 414, all known to Node's ICU; every city has one |
| Index migration on the full table | 29 s |
| Search, any query of 2+ characters | **under 85 ms** first time, usually 1 to 3 ms (`al` 45 ms, `san` 55 ms, `sant` 20 ms, `München` 1 to 3 ms, `Мюнхен` 1 ms) |
| Checks | 0 PPLX and 0 historical rows stored; 0 orphaned other names; counts equal the pre-import audit |

A single letter takes about 150 to 400 ms; the API does not accept fewer than 2 characters.
Before the covering indexes (migration `20261106130000`) the same short searches took 3 to 11
seconds; the full table is why a small test fixture could never show it.

## Freshness: refresh every 90 days, refused after 180

| Age of the last import | State | What happens |
|---|---|---|
| under 90 days | `ok` | nothing |
| 90 to 180 days | `refresh_due` | still accepted; a **warning is logged** at start-up and then at most once a day: refresh now |
| over 180 days | `stale` | every lookup fails with 503 `city_data_stale`; an **error is logged** |
| nothing imported | `empty` | 503 `city_data_not_loaded`; an error is logged |

"Last import" is the newest `verified_at` in `geonames_cities`: each import stamps everything it
saw. A record the file no longer lists keeps its old stamp and is refused after 180 days on its own.

**The 90-day reminder** is two things: the log lines above, and a command a scheduler can run:

```
node scripts/geonames-status.js --env-file .env          # add --json for machines
```

Exit code **0** ok, **1** refresh due, **2** stale or empty, **3** could not read the status. Run it
daily from whatever monitors the server and alert on a non-zero code.

`GEONAMES_MAX_AGE_DAYS` can make the limit *stricter* (a whole number of days; the reminder then starts
at the smaller of 90 and that number). It can never be raised above 180.

## Preparing the development environment (not done yet)

The development database is `humancare_dev` (check with step 2). **Until its migrations are applied,
the running dev API will fail on anything that reads or writes requests**, because the code now
selects columns that the dev database does not have yet. Nothing below has been run against it.

Preflight, all read-only (run from the `backend` folder):

1. Branch and code: `git branch --show-current` (the branch you mean to deploy) and `git status --short`.
2. Which database will be touched, without showing the password:
   ```
   node -e "const u=new URL(require('dotenv').parse(require('fs').readFileSync('.env')).DATABASE_URL);console.log(u.hostname+':'+(u.port||3306)+'/'+u.pathname.slice(1)+' as '+u.username)"
   ```
   Expect `localhost:3306/humancare_dev`. If it is anything else, stop.
3. Disk: about 6 GB free for the download (0.4 GB), the unzipped file (1.7 GB), the tables (1.2 GB) and
   MySQL's logs. If binary logging is on (`SHOW VARIABLES LIKE 'log_bin'`) the import writes a few GB more.
4. MySQL settings: `SHOW VARIABLES LIKE 'innodb_buffer_pool_size'` (the 128 MB default gave the 16 minutes
   above; more memory should be faster, not measured) and `max_allowed_packet` of at least 16 MB.
5. Back up: `mysqldump --single-transaction -u <user> -p humancare_dev > <a folder outside the repo>\humancare_dev_before_geonames.sql`
6. Migration state: `npx prisma migrate status`. Expect only unapplied ones (the four `20261106*`
   migrations of this work, plus any earlier ones the dev database does not have), none marked failed.
   A "migrations in the database that are not found locally" note is fine (they come from another branch).
7. The date column check (see `20261106110000_preferred_date_to_date/migration.sql`); a time of day in a
   value would be lost, the day is always kept:
   ```sql
   SELECT COUNT(*) FROM service_requests
   WHERE preferred_date IS NOT NULL AND preferred_date <> CAST(DATE(preferred_date) AS DATETIME(3));
   ```

Apply (stop the dev API first: on Windows it locks the Prisma engine file and `generate` fails):

```
npx prisma migrate deploy      # never "migrate dev", never "migrate reset"
npx prisma generate
```

(`npm run migrate:dev` is the same `prisma migrate deploy` against `.env`; `npm run migrate:all` also
runs it on the test database.) Start the dev API again. Then download, dry-run and import as in
"Import or update the data" with `--env-file .env --confirm-database humancare_dev`, and check
`node scripts/geonames-status.js --env-file .env` exits 0. Until the data is imported, Private
Charter requests answer 503 `city_data_not_loaded`; every other service works as soon as the migrations
are applied.

Roll back, if needed: restore the backup, or run each folder's `down.sql` by hand in the reverse order
(`20261106130000`, `120000`, `110000`, `100000`) and delete that migration's row from `_prisma_migrations`
(Prisma will not mark an applied migration as rolled back).

## Migration timestamps

The four migrations of this work are named `20261106100000` to `20261106130000`. They sort after every
existing migration, which is what matters: Prisma applies them in name order. They were not taken from the
clock (the machine's date was 5 November 2026); no other branch has a migration at or after `20261106`.
A migration another branch adds with an earlier timestamp is still applied by `migrate deploy` even after
these (out of order, which is allowed), and there is no table overlap, so the order does not matter here.

## Not covered yet / to watch

- Other names of places **without a recorded population** are not searchable (their own name and
  plain-ASCII name are). Use `--alt-min-population 0` to include them, at the cost of a larger table.
- A place that GeoNames only knows by a name in another script, with no population, may not be found.
- Airport codes appear only where GeoNames lists them as a name of the city.
- The first search after a restart is slower while MySQL warms its cache.
- Zone names unknown to the server's Node/ICU are skipped at import time (counted as `unknown-timezone`).
