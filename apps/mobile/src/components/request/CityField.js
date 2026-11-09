import { useEffect, useRef, useState } from 'react';
import { Linking, Modal, Pressable, ScrollView, View } from 'react-native';
import { ChevronDown, X } from 'lucide-react-native';
import { useApp } from '../../state/AppContext';
import { apiGet } from '../../lib/api';
import {
  GEONAMES_ATTRIBUTION_FALLBACK, SEARCH_DEBOUNCE_MS, describeCityError, searchCities, searchableQuery,
} from '../../lib/citySearch';
import { toCityChoice } from '../../lib/privateCharter';
import { IconButton } from '../layout';
import { FieldLabel, Input, Text } from '../ui';

// A city picked from the server's verified list (Private Charter). The field looks like the other
// pickers; tapping it opens a search. Nothing typed is ever kept as the answer: only a result the
// person taps becomes the value, and that is sent as { geonameId } alone.
//
// `city` is the chosen { geonameId, name, label, countryCode } or null; `onChange(city)` receives
// the chosen city.
export default function CityField({ label, required, city, onChange, error, testID }) {
  const { isRTL } = useApp();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  // idle: too short to search; loading; done: results (maybe none); error: see `problem`.
  const [state, setState] = useState('idle');
  const [cities, setCities] = useState([]);
  const [problem, setProblem] = useState(null);
  const [attribution, setAttribution] = useState(GEONAMES_ATTRIBUTION_FALLBACK);
  const latest = useRef(0);
  const timer = useRef(null);

  const run = (value) => {
    clearTimeout(timer.current);
    const query = searchableQuery(value);
    latest.current += 1;
    const mine = latest.current;
    if (!query) { setState('idle'); setCities([]); setProblem(null); return; }
    setState('loading');
    setProblem(null);
    searchCities(apiGet, query)
      .then((result) => {
        if (mine !== latest.current) return; // a newer search has started: this answer is stale
        setCities(result.cities);
        setAttribution(result.attribution);
        setState('done');
      })
      .catch((err) => {
        if (mine !== latest.current) return;
        setCities([]);
        setProblem(describeCityError(err));
        setState('error');
      });
  };

  const onType = (value) => {
    setText(value);
    clearTimeout(timer.current);
    latest.current += 1; // anything still on its way is for older text
    if (!searchableQuery(value)) { setState('idle'); setCities([]); setProblem(null); return; }
    setState('loading');
    timer.current = setTimeout(() => run(value), SEARCH_DEBOUNCE_MS);
  };

  useEffect(() => () => clearTimeout(timer.current), []);

  const close = () => { clearTimeout(timer.current); latest.current += 1; setOpen(false); };
  const openPicker = () => { setText(''); setState('idle'); setCities([]); setProblem(null); setOpen(true); };
  const pick = (result) => { onChange(toCityChoice(result)); close(); };

  return (
    <View>
      <FieldLabel required={required}>{label}</FieldLabel>
      <Pressable
        onPress={openPicker} accessibilityRole="button" testID={testID}
        accessibilityLabel={`${label}, ${city ? city.label : 'Select a city'}`}
        className="min-h-[48px] flex-row items-center justify-between gap-2 rounded-[10px] border-[1.5px] border-field bg-input px-3 py-3 active:opacity-80"
      >
        <Text className={`flex-1 text-[15px] ${city ? '' : 'text-faint'}`} numberOfLines={2}>{city ? city.label : 'Search and select a city'}</Text>
        <ChevronDown size={16} color="#97A4B8" />
      </Pressable>
      {error ? <Text className="mt-1 text-[12px] text-danger">{error}</Text> : null}

      <Modal visible={open} transparent animationType="fade" onRequestClose={close} statusBarTranslucent>
        <Pressable onPress={close} className="flex-1 items-center justify-start bg-navy/45 px-5 pt-16" style={{ direction: isRTL ? 'rtl' : 'ltr' }}>
          <Pressable className="w-full max-w-[420px] rounded-2xl bg-white p-4" onPress={(e) => e.stopPropagation()}>
            <View className="mb-2.5 flex-row items-center justify-between">
              <Text className="font-inter-black text-[15px] text-navy">{label}</Text>
              <IconButton onPress={close} className="h-[28px] w-[28px]"><X size={14} color="#45526B" /></IconButton>
            </View>
            <Input
              autoFocus value={text} onChangeText={onType} placeholder="Type the first letters of a city" autoCorrect={false}
              autoCapitalize="words" returnKeyType="search" maxLength={80} accessibilityLabel={`${label}: search`}
            />
            <ScrollView style={{ maxHeight: 280 }} className="mt-2" showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
              {state === 'idle' && <Text className="px-1 py-3 text-[13px] text-muted">Type at least 2 letters to search the list of cities.</Text>}
              {state === 'loading' && <Text className="px-1 py-3 text-[13px] text-muted">Searching…</Text>}
              {state === 'done' && cities.length === 0 && (
                <Text className="px-1 py-3 text-[13px] text-muted">No matching city. Check the spelling, or try the nearest larger city.</Text>
              )}
              {state === 'error' && problem && (
                <View className="py-2">
                  <Text className="px-1 text-[13px] text-danger">{problem.message}</Text>
                  {problem.retry && (
                    <Pressable
                      onPress={() => run(text)} accessibilityRole="button" accessibilityLabel="Retry city search"
                      className="mt-2 min-h-[44px] items-center justify-center rounded-xl border-[1.5px] border-primary active:opacity-80"
                    >
                      <Text className="font-inter-bold text-[14px] text-primary">Retry</Text>
                    </Pressable>
                  )}
                </View>
              )}
              {state === 'done' && cities.map((result) => (
                <Pressable
                  key={result.geonameId} onPress={() => pick(result)} accessibilityRole="button" accessibilityLabel={result.label}
                  className={`min-h-[44px] justify-center border-b border-line px-1 py-2.5 active:opacity-70 ${city && city.geonameId === result.geonameId ? 'bg-primary-soft' : ''}`}
                >
                  <Text className="text-[14.5px] text-ink">{result.label}</Text>
                </Pressable>
              ))}
            </ScrollView>
            <Pressable onPress={() => Linking.openURL(attribution.url).catch(() => {})} accessibilityRole="link" accessibilityLabel={attribution.text} className="mt-3">
              <Text className="text-[11px] leading-4 text-faint">{attribution.text}</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}
