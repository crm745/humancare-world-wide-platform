import { Platform, Text, TextInput, View } from 'react-native';
import { ChevronLeft, Search, X } from 'lucide-react-native';
import { useApp } from '../../state/AppContext';
import { goBack } from '../../lib/nav';
import { headerSpec, scaleFor } from '../../lib/myRequestsLayout';
import { PressBox } from '../PressBox';
import { ConnectionBanner } from '../network/ConnectionBanner';

// The header of the Tracking tab, laid out exactly like the My Requests header (components/requests/RequestsHeader.js): ONE white block with the back button and title, and the search field directly
// below it, with the same sizes (lib/myRequestsLayout.js headerSpec), spacing and colours, and a single line under the whole block (none between the title row and the search). There is no filter button and
// no chips. The search field has a clear (x) button while there is text; with no active requests there is no search field and the block is just the title row. The rows mirror in Arabic by themselves.
const NAVY = '#0D2340';
const MUTED = '#5B6B84';
const INK = '#17233D';
const LINE = '#E4E9F2';
const SOFT = '#EEF3FB';

export function TrackingSearch({ width, title, showSearch = true, value, onChange }) {
  const { t, isRTL } = useApp();
  const L = headerSpec(scaleFor(width));
  const placeholder = t('tr_search_ph');
  return (
    <>
      <View style={{ backgroundColor: '#FFFFFF', borderBottomWidth: 1, borderBottomColor: LINE, paddingTop: L.padTop, paddingHorizontal: L.padSide, paddingBottom: L.padBottom, gap: L.gap }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: L.titleGap }}>
          <PressBox
            accessibilityRole="button" accessibilityLabel={t('home_back')} onPress={goBack}
            style={({ pressed }) => ({ width: L.back, height: L.back, borderRadius: L.backRadius, backgroundColor: SOFT, alignItems: 'center', justifyContent: 'center', opacity: pressed ? 0.7 : 1 })}
          >
            <View style={isRTL ? { transform: [{ scaleX: -1 }] } : null}>
              <ChevronLeft size={L.chevron} strokeWidth={2.2} color={NAVY} />
            </View>
          </PressBox>
          <Text accessibilityRole="header" style={{ flex: 1, fontFamily: 'Inter_800ExtraBold', fontSize: L.titleSize, lineHeight: L.titleLine, color: NAVY }}>{title}</Text>
        </View>
        {showSearch ? (
          <View style={{ height: L.searchHeight, flexDirection: 'row', alignItems: 'center', gap: L.searchGap, paddingHorizontal: L.searchPadX, borderRadius: L.searchRadius, backgroundColor: '#F5F8FC', borderWidth: 1, borderColor: LINE }}>
            <Search size={L.searchIcon} color={MUTED} />
            <TextInput
              testID="tracking-search"
              value={value} onChangeText={onChange} placeholder={placeholder} placeholderTextColor="#8A97AB" accessibilityLabel={placeholder}
              returnKeyType="search" autoCorrect={false} autoCapitalize="none"
              style={[{ flex: 1, minWidth: 0, height: L.searchHeight, padding: 0, fontFamily: 'Inter_400Regular', fontSize: L.searchFont, color: INK }, Platform.OS === 'web' ? { outlineStyle: 'none' } : null]}
            />
            {value ? (
              <PressBox testID="tracking-search-clear" accessibilityRole="button" accessibilityLabel={t('docs_clear_search')} onPress={() => onChange('')} hitSlop={10}>
                <X size={L.searchIcon} color={MUTED} />
              </PressBox>
            ) : null}
          </View>
        ) : null}
      </View>
      <ConnectionBanner />
    </>
  );
}
