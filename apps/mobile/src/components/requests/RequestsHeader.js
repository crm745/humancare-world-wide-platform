import { Platform, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { ChevronLeft, Search, SlidersHorizontal } from 'lucide-react-native';

// The My Requests header (its own, not the shared TopBar / SearchHeader): the back button and title, the search field and
// the filter button, and the status chips. Values are the design's: white, a 1px bottom border, 20 / 23 / 14 padding and
// a 16 gap between the three rows.
const NAVY = '#0D2340';
const INK = '#17233D';
const MUTED = '#5B6B84';
const LINE = '#E4E9F2';
const SOFT = '#EEF3FB';
const FONT = { 500: 'Inter_500Medium', 700: 'Inter_700Bold', 800: 'Inter_800ExtraBold' };

function Chip({ label, count, on, onPress, t }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: on }}
      accessibilityLabel={`${label}, ${count}`}
      onPress={onPress}
      hitSlop={{ top: 3, bottom: 3 }}
      style={{
        height: 38, borderRadius: 999, paddingLeft: 14, paddingRight: 8, flexDirection: 'row', alignItems: 'center', gap: 8,
        backgroundColor: on ? NAVY : '#FFFFFF', borderWidth: on ? 0 : 1, borderColor: LINE,
      }}
    >
      <Text style={{ fontFamily: FONT[700], fontSize: 14, color: on ? '#FFFFFF' : INK }}>{label}</Text>
      <View style={{ minWidth: 22, paddingVertical: 2, paddingHorizontal: 6, borderRadius: 999, alignItems: 'center', backgroundColor: on ? 'rgba(255,255,255,0.18)' : '#EEF1F6' }}>
        <Text style={{ fontFamily: FONT[800], fontSize: 12, color: on ? '#FFFFFF' : MUTED }}>{count}</Text>
      </View>
    </Pressable>
  );
}

// chips: [{ value, label, count }]
export function RequestsHeader({ title, backLabel, searchPlaceholder, filterLabel, query, onQuery, onBack, onFilters, chips, value, onChange, isRTL }) {
  return (
    <View style={{ backgroundColor: '#FFFFFF', borderBottomWidth: 1, borderBottomColor: LINE, paddingTop: 20, paddingHorizontal: 23, paddingBottom: 14, gap: 16 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
        <Pressable
          accessibilityRole="button" accessibilityLabel={backLabel} onPress={onBack}
          style={({ pressed }) => ({ width: 52, height: 52, borderRadius: 14, backgroundColor: SOFT, alignItems: 'center', justifyContent: 'center', opacity: pressed ? 0.7 : 1 })}
        >
          <View style={isRTL ? { transform: [{ scaleX: -1 }] } : null}>
            <ChevronLeft size={22} strokeWidth={2.2} color={NAVY} />
          </View>
        </Pressable>
        <Text accessibilityRole="header" style={{ flex: 1, fontFamily: FONT[800], fontSize: 20, lineHeight: 26, color: NAVY }}>{title}</Text>
      </View>

      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <View style={{ flex: 1, height: 50, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, borderRadius: 14, backgroundColor: '#F5F8FC', borderWidth: 1, borderColor: LINE }}>
          <Search size={20} color={MUTED} />
          <TextInput
            value={query} onChangeText={onQuery} placeholder={searchPlaceholder} placeholderTextColor="#8A97AB" accessibilityLabel={searchPlaceholder}
            returnKeyType="search" autoCorrect={false} autoCapitalize="none"
            style={[{ flex: 1, minWidth: 0, height: 50, padding: 0, fontFamily: 'Inter_400Regular', fontSize: 15, color: INK }, Platform.OS === 'web' ? { outlineStyle: 'none' } : null]}
          />
        </View>
        <Pressable
          accessibilityRole="button" accessibilityLabel={filterLabel} onPress={onFilters}
          style={({ pressed }) => ({ width: 50, height: 50, borderRadius: 14, backgroundColor: SOFT, alignItems: 'center', justifyContent: 'center', opacity: pressed ? 0.7 : 1 })}
        >
          <SlidersHorizontal size={20} color={NAVY} />
        </Pressable>
      </View>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
        {chips.map((c) => <Chip key={c.value} label={c.label} count={c.count} on={value === c.value} onPress={() => onChange(c.value)} />)}
      </ScrollView>
    </View>
  );
}
