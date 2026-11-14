import { Platform, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { ChevronLeft, Search, SlidersHorizontal } from 'lucide-react-native';
import { headerSpec, scaleFor } from '../../lib/myRequestsLayout';
import { COLORS } from '../../theme/colors';
import { PressBox } from '../PressBox';

// The My Requests header (its own, not the shared TopBar / SearchHeader): the back button and title, the search field and
// the filter button, and the status chips. The sizes are the design's (lib/myRequestsLayout.js), scaled to the screen.
const NAVY = '#0D2340';
const INK = '#17233D';
const MUTED = '#5B6B84';
const LINE = '#E4E9F2';
const SOFT = '#EEF3FB';
const FONT = { 700: 'Inter_700Bold', 800: 'Inter_800ExtraBold' };

function Chip({ label, count, on, onPress, L }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: on }}
      accessibilityLabel={`${label}, ${count}`}
      onPress={onPress}
      hitSlop={{ top: L.chipHitSlop, bottom: L.chipHitSlop }}
      style={{
        height: L.chipHeight, borderRadius: 999, paddingLeft: L.chipPadLeft, paddingRight: L.chipPadRight, flexDirection: 'row', alignItems: 'center', gap: L.chipGap,
        backgroundColor: on ? COLORS.primary : '#FFFFFF', borderWidth: on ? 0 : 1, borderColor: LINE,
      }}
    >
      <Text style={{ fontFamily: FONT[700], fontSize: L.chipFont, color: on ? '#FFFFFF' : INK }}>{label}</Text>
      <View style={{ minWidth: L.bubbleMin, paddingVertical: L.bubblePadY, paddingHorizontal: L.bubblePadX, borderRadius: 999, alignItems: 'center', backgroundColor: on ? 'rgba(255,255,255,0.18)' : '#EEF1F6' }}>
        <Text style={{ fontFamily: FONT[800], fontSize: L.bubbleFont, color: on ? '#FFFFFF' : MUTED }}>{count}</Text>
      </View>
    </Pressable>
  );
}

// chips: [{ value, label, count }]; `width` is the screen's width
export function RequestsHeader({ width, title, backLabel, searchPlaceholder, filterLabel, query, onQuery, onBack, onFilters, chips, value, onChange, isRTL }) {
  const L = headerSpec(scaleFor(width));
  return (
    <View style={{ backgroundColor: '#FFFFFF', borderBottomWidth: 1, borderBottomColor: LINE, paddingTop: L.padTop, paddingHorizontal: L.padSide, paddingBottom: L.padBottom, gap: L.gap }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: L.titleGap }}>
        <PressBox
          accessibilityRole="button" accessibilityLabel={backLabel} onPress={onBack}
          style={({ pressed }) => ({ width: L.back, height: L.back, borderRadius: L.backRadius, backgroundColor: SOFT, alignItems: 'center', justifyContent: 'center', opacity: pressed ? 0.7 : 1 })}
        >
          <View style={isRTL ? { transform: [{ scaleX: -1 }] } : null}>
            <ChevronLeft size={L.chevron} strokeWidth={2.2} color={NAVY} />
          </View>
        </PressBox>
        <Text accessibilityRole="header" style={{ flex: 1, fontFamily: FONT[800], fontSize: L.titleSize, lineHeight: L.titleLine, color: NAVY }}>{title}</Text>
      </View>

      <View style={{ flexDirection: 'row', alignItems: 'center', gap: L.rowGap }}>
        <View style={{ flex: 1, height: L.searchHeight, flexDirection: 'row', alignItems: 'center', gap: L.searchGap, paddingHorizontal: L.searchPadX, borderRadius: L.searchRadius, backgroundColor: '#F5F8FC', borderWidth: 1, borderColor: LINE }}>
          <Search size={L.searchIcon} color={MUTED} />
          <TextInput
            value={query} onChangeText={onQuery} placeholder={searchPlaceholder} placeholderTextColor="#8A97AB" accessibilityLabel={searchPlaceholder}
            returnKeyType="search" autoCorrect={false} autoCapitalize="none"
            style={[{ flex: 1, minWidth: 0, height: L.searchHeight, padding: 0, fontFamily: 'Inter_400Regular', fontSize: L.searchFont, color: INK }, Platform.OS === 'web' ? { outlineStyle: 'none' } : null]}
          />
        </View>
        <PressBox
          accessibilityRole="button" accessibilityLabel={filterLabel} onPress={onFilters}
          style={({ pressed }) => ({ width: L.filter, height: L.filter, borderRadius: L.searchRadius, backgroundColor: SOFT, alignItems: 'center', justifyContent: 'center', opacity: pressed ? 0.7 : 1 })}
        >
          <SlidersHorizontal size={L.filterIcon} color={NAVY} />
        </PressBox>
      </View>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: L.chipsGap }}>
        {chips.map((c) => <Chip key={c.value} label={c.label} count={c.count} on={value === c.value} onPress={() => onChange(c.value)} L={L} />)}
      </ScrollView>
    </View>
  );
}
