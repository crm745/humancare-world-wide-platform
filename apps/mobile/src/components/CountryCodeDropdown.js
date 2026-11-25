import { Pressable, ScrollView, View } from 'react-native';
import { Check, ChevronDown } from 'lucide-react-native';
import { COUNTRY_CODES, CALLING_CODE_COUNTRY } from '../data/mock';
import { codeRows, rowText } from '../lib/countryCodeDropdown';
import { Text } from './ui';
import { PressBox } from './PressBox';
import { COLORS } from '../theme/colors';

// The login screen's country-code field, like a plain select: a small button that shows the country code and dial code ("IN +91"), and under it, attached to the button, a compact list of the same
// ("US +1", "GB +44") that scrolls. No modal, no search, no country names. It sits in the row with the number field (`children`), and the value is still the dial code ("+91").
// The list is drawn inside the page (not a modal), in the page's own flow right under the button (it makes room for itself, so it is always inside its parent's bounds: it can be touched and scrolled
// on Android, iOS and the web, which a list floating outside its parent cannot), above its neighbours (zIndex). Picking a row or tapping the button again closes it (the app has ONE back-button handler, at the root, so this list does not add its own). A tap anywhere else closes it too: the
// screen draws `CountryCodeBackdrop` under the field while it is open (it must be a child of the page's content, so it covers the page), and the screen owns `open`.
export const CODE_LIST_MAX = 240;

export function CountryCodeBackdrop({ onPress }) {
  return <Pressable accessible={false} importantForAccessibility="no" onPress={onPress} style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 1 }} />;
}

const ROWS = codeRows(COUNTRY_CODES, CALLING_CODE_COUNTRY);

export function CountryCodeField({ value, onChange, open, onOpenChange, title, children, large = true, buttonWidth = 128 }) {
  const selected = ROWS.find((r) => r.code === value);
  const pick = (code) => { onChange(code); onOpenChange(false); };

  return (
    <View style={{ zIndex: 2 }}>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Pressable
          onPress={() => onOpenChange(!open)} accessibilityRole="button" accessibilityLabel={`${title}, ${selected ? rowText(selected) : value}`} accessibilityState={{ expanded: open }}
          style={{ width: buttonWidth }}
          className={`flex-row items-center justify-between gap-1 rounded-[10px] border-[1.5px] bg-input ${open ? 'border-primary' : 'border-field'} ${large ? 'px-3 py-3.5' : 'px-3 py-3'}`}
        >
          <Text style={{ fontSize: 16 }} numberOfLines={1}>{selected ? rowText(selected) : value}</Text>
          <View style={open ? { transform: [{ rotate: '180deg' }] } : null}><ChevronDown size={16} color="#97A4B8" /></View>
        </Pressable>
        {children}
      </View>
      {open ? (
        <View
          style={{
            marginTop: 2, width: buttonWidth, backgroundColor: '#FFFFFF', borderRadius: 10, borderWidth: 1.5, borderColor: COLORS.primary, overflow: 'hidden',
            shadowColor: '#0D2340', shadowOpacity: 0.16, shadowRadius: 14, shadowOffset: { width: 0, height: 6 }, elevation: 10,
          }}
        >
          <ScrollView style={{ maxHeight: CODE_LIST_MAX }} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator nestedScrollEnabled>
            {ROWS.map((r, i) => {
              const on = r.code === value;
              return (
                <PressBox
                  key={r.code} onPress={() => pick(r.code)} accessibilityRole="button" accessibilityState={{ selected: on }} accessibilityLabel={rowText(r)}
                  style={({ pressed }) => ({ minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, paddingHorizontal: 12, borderTopWidth: i === 0 ? 0 : 1, borderTopColor: '#EEF1F6', backgroundColor: on ? COLORS.primarySoft : pressed ? '#F2F6FC' : '#FFFFFF' })}
                >
                  <Text style={{ fontSize: 16, color: '#0D2340' }} numberOfLines={1}>{rowText(r)}</Text>
                  {on ? <Check size={16} color={COLORS.primary} strokeWidth={2.6} /> : null}
                </PressBox>
              );
            })}
          </ScrollView>
        </View>
      ) : null}
    </View>
  );
}
