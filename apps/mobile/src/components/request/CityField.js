import { useEffect, useRef, useState } from 'react';
import { Linking, Pressable, ScrollView, View } from 'react-native';
import { apiGet } from '../../lib/api';
import {
  GEONAMES_ATTRIBUTION_FALLBACK, SEARCH_DEBOUNCE_MS, describeCityError, normaliseCityText, searchCitiesCached, searchableQuery,
} from '../../lib/citySearch';
import { toCityChoice } from '../../lib/privateCharter';
import { suggestionsFor } from '../../lib/locationRules';
import { FieldLabel, Input, Text } from '../ui';
import { Spinner } from '../Spinner';
import { useListMaxHeight, useReveal } from '../keyboard';
import { WRAP } from './DetailsParts';
import { COLORS } from '../../theme/colors';

// A city (or place) typed into the field, with suggestions in a compact dropdown right under it. No modal, no separate screen.
//
//   - The person types; whatever they type is kept exactly as typed (`value`, reported by onChangeText). Nothing is ever replaced for them.
//   - From two letters on, matching cities from the server's verified list (GeoNames, via GET /geo/cities, the same search as before) are
//     listed under the field. Tapping one fills the field with it and closes the list (onSelect receives { geonameId, name, label, countryCode }).
//   - The list closes when the field loses focus (a tap anywhere else, or another field) and opens again when the field is focused.
//   - `countryIso` / `countryName` / `restrictToCountry`: when the field is held to the form's country, only the suggestions of that country are listed
//     (a city of another country cannot be picked), and the empty message says which country was searched. Typed text is never filtered.
//   - `structured` (Private Charter): the backend accepts a city only as a verified { geonameId }, so `city` holds the picked city; typing again
//     clears it (the form clears it in onChangeText) until another is picked. Without `structured` (every other service) the text is the answer.
export default function CityField({ label, required, value = '', city = null, onChangeText, onSelect, error, testID, structured = false, countryIso = '', countryName = '', restrictToCountry = false }) {
  const reveal = useReveal();
  // The list gets what is left above the keyboard, at most 220 px (the top bars, the label, the field and the Continue bar take the rest).
  const listMax = useListMaxHeight({ reserved: 300, min: 110, max: 220 });
  const [open, setOpen] = useState(false);
  // idle: too short to search; loading; done: results (maybe none); error: see `problem`.
  const [state, setState] = useState('idle');
  const [cities, setCities] = useState([]);
  const [problem, setProblem] = useState(null);
  const [attribution, setAttribution] = useState(GEONAMES_ATTRIBUTION_FALLBACK);
  const latest = useRef(0); // which search the screen is waiting for; an older answer is dropped
  const timer = useRef(null);
  const blurTimer = useRef(null);
  const pressing = useRef(false); // a suggestion is being pressed: the field's blur must not close the list under the finger
  const shown = useRef(''); // the text the list on screen is for, so the same text is never searched twice
  const box = useRef(null);

  const run = (text) => {
    clearTimeout(timer.current);
    const query = searchableQuery(text);
    latest.current += 1;
    const mine = latest.current;
    if (!query) { shown.current = ''; setState('idle'); setCities([]); setProblem(null); return; }
    const key = normaliseCityText(query);
    if (shown.current === key) return; // this list is already on screen
    setState('loading');
    setProblem(null);
    searchCitiesCached(apiGet, query)
      .then((result) => {
        if (mine !== latest.current) return; // a newer search has started: this answer is stale
        shown.current = key;
        setCities(result.cities);
        setAttribution(result.attribution);
        setState('done');
      })
      .catch((err) => {
        if (mine !== latest.current) return;
        shown.current = '';
        setCities([]);
        setProblem(describeCityError(err));
        setState('error');
      });
  };

  const onType = (text) => {
    onChangeText(text);
    setOpen(true);
    clearTimeout(timer.current);
    latest.current += 1; // anything still on its way is for older text
    if (!searchableQuery(text)) { shown.current = ''; setState('idle'); setCities([]); setProblem(null); return; }
    if (normaliseCityText(text) !== shown.current) setState('loading');
    timer.current = setTimeout(() => run(text), SEARCH_DEBOUNCE_MS);
  };

  const onFocus = () => {
    clearTimeout(blurTimer.current);
    setOpen(true);
    if (searchableQuery(value)) run(value); // reopens with the list for what is already typed
  };

  const onBlur = () => {
    clearTimeout(blurTimer.current);
    blurTimer.current = setTimeout(() => {
      if (pressing.current) return;
      clearTimeout(timer.current);
      latest.current += 1;
      setOpen(false);
    }, 150);
  };

  const pick = (result) => {
    pressing.current = false;
    clearTimeout(timer.current);
    latest.current += 1;
    const choice = toCityChoice(result);
    shown.current = normaliseCityText(choice.label);
    onSelect(choice);
    setOpen(false);
  };

  useEffect(() => () => { clearTimeout(timer.current); clearTimeout(blurTimer.current); }, []);

  // What is listed: the verified results, of the selected country when this field is held to it.
  const listed = suggestionsFor(cities, { countryIso, restrict: restrictToCountry, max: 10 });
  const inCountry = restrictToCountry && countryIso ? ` in ${countryName || 'the selected country'}` : '';
  const visible = open && state !== 'idle';
  // The open list is brought into view above the keyboard (the form scrolls just enough).
  useEffect(() => {
    if (!visible) return undefined;
    const t = setTimeout(() => reveal(box), 60);
    return () => clearTimeout(t);
  }, [visible, state, listed.length, reveal]);

  const chosen = structured && city ? city.geonameId : null;
  return (
    <View testID={testID}>
      <FieldLabel required={required}>{label}</FieldLabel>
      <Input
        value={value} onChangeText={onType} onFocus={onFocus} onBlur={onBlur}
        placeholder="City, Country" autoCorrect={false} autoCapitalize="words" maxLength={80}
        accessibilityLabel={label} autoComplete="off"
      />
      {error ? <Text className="mt-1 text-[12px] text-danger">{error}</Text> : null}

      {visible ? (
        <View
          ref={box} collapsable={false}
          className="mt-1.5 overflow-hidden rounded-xl border border-line bg-white"
          style={{ shadowColor: '#0D2340', shadowOpacity: 0.08, shadowRadius: 8, shadowOffset: { width: 0, height: 3 }, elevation: 3 }}
        >
          {state === 'loading' ? (
            <View className="flex-row items-center gap-2.5 px-3.5 py-3" accessibilityRole="progressbar" accessibilityLabel="Searching cities">
              <Spinner size={16} color={COLORS.primary} trackColor={COLORS.primarySoft} />
              <Text className="text-[13px] text-muted">Searching…</Text>
            </View>
          ) : null}
          {state === 'done' && listed.length === 0 ? (
            <Text className="px-3.5 py-3 text-[13px] leading-[19px] text-muted">
              {structured ? `No matching city${inCountry}. Check the spelling, or try the nearest larger city.` : `No matching city${inCountry}. You can keep what you typed.`}
            </Text>
          ) : null}
          {state === 'error' && problem ? (
            <View className="px-3.5 py-3">
              <Text className="text-[13px] leading-[19px] text-danger">{problem.message}</Text>
              {problem.retry ? (
                <Pressable
                  onPress={() => { shown.current = ''; run(value); }} accessibilityRole="button" accessibilityLabel="Retry city search"
                  className="mt-2 min-h-[44px] items-center justify-center rounded-xl border-[1.5px] border-primary active:opacity-80"
                >
                  <Text className="font-inter-bold text-[14px] text-primary">Retry</Text>
                </Pressable>
              ) : null}
            </View>
          ) : null}
          {state === 'done' && listed.length > 0 ? (
            <>
              <ScrollView style={{ maxHeight: listMax }} nestedScrollEnabled showsVerticalScrollIndicator keyboardShouldPersistTaps="handled">
                {listed.map((result, i) => (
                  <Pressable
                    key={result.geonameId}
                    onPressIn={() => { pressing.current = true; }} onPressOut={() => { pressing.current = false; }}
                    onPress={() => pick(result)} accessibilityRole="button" accessibilityLabel={result.label}
                    className={`min-h-[44px] justify-center px-3.5 py-2.5 active:bg-soft ${i > 0 ? 'border-t border-divider' : ''} ${chosen === result.geonameId ? 'bg-primary-soft' : ''}`}
                  >
                    <Text className="text-[14.5px] leading-5 text-ink" style={WRAP}>{result.label}</Text>
                  </Pressable>
                ))}
              </ScrollView>
              {/* GeoNames data is CC BY 4.0: it is credited wherever its results are shown. */}
              <Pressable
                onPress={() => Linking.openURL(attribution.url).catch(() => {})} accessibilityRole="link" accessibilityLabel={attribution.text}
                className="border-t border-divider px-3.5 py-2"
              >
                <Text className="text-[11px] leading-4 text-faint">{attribution.text}</Text>
              </Pressable>
            </>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
