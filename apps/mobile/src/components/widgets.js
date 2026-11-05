import { useRef, useState } from 'react';
import { Dimensions, Image, ImageBackground, Modal, Platform, Pressable, ScrollView, TextInput, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Check, ChevronDown, Download, Eye, EyeOff, FileText, Search, X } from 'lucide-react-native';
import { useApp } from '../state/AppContext';
import { IMAGES } from '../data/images';
import { IconButton } from './layout';
import { FieldLabel, Input, Text } from './ui';

// Bottom sheet with a dimmed backdrop (filter, language and select sheets).
export function Sheet({ visible, onClose, title, children }) {
  const insets = useSafeAreaInsets();
  const { isRTL } = useApp();
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <View className="flex-1 justify-end" style={{ direction: isRTL ? 'rtl' : 'ltr' }}>
        <Pressable onPress={onClose} className="absolute inset-0 bg-navy/45" />
        <View className="rounded-t-[20px] bg-white px-5 pt-5" style={{ paddingBottom: 24 + insets.bottom }}>
          <View className="mb-[18px] flex-row items-center justify-between">
            <Text className="font-inter-black text-[16px] text-navy">{title}</Text>
            <IconButton onPress={onClose} className="h-[30px] w-[30px]"><X size={16} color="#45526B" /></IconButton>
          </View>
          {/* Short lists (Gender, filters) just render at their natural height; long ones
              (country codes) now scroll within the sheet instead of overflowing off-screen.
              A fixed pixel maxHeight, not a percentage — this wrapper is auto-height (sized
              to its content, bottom-anchored), and a percentage has no sized ancestor to
              resolve against, which collapses to 0 on web instead of falling back sanely. */}
          <ScrollView style={{ maxHeight: Dimensions.get('window').height * 0.7 }} showsVerticalScrollIndicator={false}>
            {children}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

// A compact, centered picker — distinct from Sheet (which stays full-size for things
// that genuinely need the room, like FilterSheet's whole form). This is just for a
// flat list of choices, so it shouldn't take over the screen the way a bottom sheet
// does, however many options there are.
function Dropdown({ visible, onClose, title, header, children }) {
  const { isRTL } = useApp();
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <Pressable onPress={onClose} className="flex-1 items-center justify-center bg-navy/45 p-6" style={{ direction: isRTL ? 'rtl' : 'ltr' }}>
        <Pressable className="w-full max-w-[320px] rounded-2xl bg-white p-4" onPress={(e) => e.stopPropagation()}>
          <View className="mb-2.5 flex-row items-center justify-between">
            <Text className="font-inter-black text-[15px] text-navy">{title}</Text>
            <IconButton onPress={onClose} className="h-[28px] w-[28px]"><X size={14} color="#45526B" /></IconButton>
          </View>
          {header}
          <ScrollView style={{ maxHeight: Dimensions.get('window').height * 0.5 }} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
            {children}
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

// Stand-in for the prototype's <select>: looks like an input, opens a compact picker.
// bare drops the border/background/radius so the select can sit inside a custom
// grouped container (e.g. login's stacked country+number card) instead of looking
// like its own separate field. labels is an optional { optionValue: displayText } map
// (e.g. "+91" -> "IN +91") — the actual value stored/returned is unchanged, only what's
// shown changes.
//
// A long list (countries, calling codes) gets a search box: typing narrows it by what is shown
// ("emir") or by the value itself ("+971"), ignoring case and accents. Short lists have none.
const SEARCH_FROM = 12;
const plain = (text) => String(text || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim();

export function Select({ value, options, onChange, title, large, bare, labels, placeholder, className = '' }) {
  const { t } = useApp();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const show = (o) => (labels && labels[o]) || o;
  const searchable = options.length > SEARCH_FROM;
  const q = plain(query);
  const shown = searchable && q ? options.filter((o) => plain(show(o)).includes(q) || plain(o).includes(q)) : options;
  const close = () => { setOpen(false); setQuery(''); };
  const search = searchable ? (
    <View className="mb-2.5 flex-row items-center gap-2 rounded-[10px] border-[1.5px] border-field bg-input px-3">
      <Search size={15} color="#97A4B8" />
      <TextInput
        value={query} onChangeText={setQuery} autoCorrect={false} autoCapitalize="none" autoFocus={Platform.OS === 'web'}
        accessibilityLabel={t('country_picker_search')} placeholder={t('country_picker_search')} placeholderTextColor="#97A4B8"
        className="min-h-[44px] flex-1 font-inter text-[14px] text-ink"
      />
    </View>
  ) : null;
  return (
    <>
      <Pressable
        onPress={() => setOpen(true)}
        className={`flex-row items-center justify-between gap-1 ${bare ? '' : 'rounded-[10px] border-[1.5px] border-field bg-input'} ${large ? 'px-3 py-3.5' : 'px-3 py-3'} ${className}`}
      >
        <Text className={`${value ? '' : 'text-faint'} ${labels ? 'text-[13px]' : large ? 'text-[16.5px]' : 'text-[15px]'}`} numberOfLines={1}>{value ? show(value) : placeholder || title}</Text>
        <ChevronDown size={16} color="#97A4B8" />
      </Pressable>
      <Dropdown visible={open} onClose={close} title={title} header={search}>
        <View className="gap-1.5">
          {shown.length === 0 ? <Text className="py-4 text-center text-[13.5px] text-muted">{t('country_picker_empty')}</Text> : null}
          {shown.map((o) => (
            <Pressable
              key={o}
              onPress={() => { onChange(o); close(); }}
              className={`flex-row items-center justify-between rounded-lg border-[1.5px] px-3 py-2.5 ${o === value ? 'border-primary bg-primary-soft' : 'border-line bg-white'}`}
            >
              <Text className="font-inter-bold text-[13.5px] text-navy">{show(o)}</Text>
              {o === value && <Check size={16} color="#1A73E8" strokeWidth={2.5} />}
            </Pressable>
          ))}
        </View>
      </Dropdown>
    </>
  );
}

// Six single-digit boxes that auto-advance, like the prototype's otpAdvance().
export function OtpInput({ value, onChange, large, error }) {
  const refs = useRef([]);
  const digits = Array.from({ length: 6 }, (_, i) => value[i] || '');
  const setDigit = (i, raw) => {
    let typed = raw.replace(/[^0-9]/g, '');
    // Several digits arriving at once is a paste or SMS autofill. A full code fills
    // every box; a partial one fills forward from this box.
    if (typed.length > 2) {
      if (digits[i] && typed.length > 6 && typed.startsWith(digits[i])) typed = typed.slice(1);
      typed = typed.slice(0, 6);
      const next = typed.length === 6 ? typed.split('') : [...digits];
      if (typed.length < 6) typed.split('').forEach((d, k) => { if (i + k < 6) next[i + k] = d; });
      onChange(next.join(''));
      const last = Math.min(typed.length === 6 ? 5 : i + typed.length, 5);
      refs.current[last]?.focus();
      return;
    }
    const d = typed.slice(-1);
    const next = [...digits];
    next[i] = d;
    onChange(next.join(''));
    if (d && i < 5) refs.current[i + 1]?.focus();
  };
  const onKey = (i, e) => {
    if (e.nativeEvent.key === 'Backspace' && !digits[i] && i > 0) refs.current[i - 1]?.focus();
  };
  return (
    <View className="flex-row gap-2" style={{ direction: 'ltr' }}>
      {digits.map((d, i) => (
        <TextInput
          key={i}
          ref={(r) => (refs.current[i] = r)}
          value={d}
          onChangeText={(v) => setDigit(i, v)}
          onKeyPress={(e) => onKey(i, e)}
          keyboardType="number-pad"
          // Room for a pasted/autofilled code; setDigit keeps one digit per box.
          maxLength={12}
          // Lets iOS/Android offer the code from the SMS above the keyboard.
          textContentType={i === 0 ? 'oneTimeCode' : 'none'}
          autoComplete={i === 0 ? 'sms-otp' : 'off'}
          // Zero basis + minWidth 0: web inputs otherwise keep an intrinsic width and overflow the row.
          style={{ flexGrow: 1, flexBasis: 0, minWidth: 0 }}
          className={`rounded-[10px] border-2 ${error ? 'border-danger' : 'border-field'} bg-input text-center font-inter-bold text-ink ${large ? 'py-3.5 text-[21.5px]' : 'py-3 text-[19.5px]'}`}
        />
      ))}
    </View>
  );
}

export const otpComplete = (v) => /^\d{6}$/.test(v);

export function PasswordField({ label, value, onChangeText, placeholder, required, error, hint }) {
  const [hidden, setHidden] = useState(true);
  const Icon = hidden ? Eye : EyeOff;
  return (
    <View>
      <FieldLabel large required={required}>{label}</FieldLabel>
      <View className="justify-center">
        <Input large secureTextEntry={hidden} value={value} onChangeText={onChangeText} placeholder={placeholder} className="pr-11" />
        <Pressable onPress={() => setHidden(!hidden)} className="absolute right-3 p-1">
          <Icon size={18} color="#97A4B8" strokeWidth={1.8} />
        </Pressable>
      </View>
      {error ? <Text className="mt-1 text-[12px] text-danger">{error}</Text> : hint ? <Text className="mt-1 text-[12px] text-faint">{hint}</Text> : null}
    </View>
  );
}

// 3-step progress dots for the request form (step 3 = review).
export function ServiceTile({ img, title, sub, onPress }) {
  return (
    <Pressable
      onPress={onPress}
      className="w-[48%] overflow-hidden rounded-2xl border border-line bg-white active:opacity-85"
      style={{ shadowColor: '#0D2340', shadowOpacity: 0.1, shadowRadius: 10, shadowOffset: { width: 0, height: 8 }, elevation: 3 }}
    >
      <Image source={IMAGES[img]} style={{ width: '100%', height: 104, backgroundColor: '#C9D6EA' }} resizeMode="cover" />
      <View className="px-3 pb-3.5 pt-3">
        <Text className="font-inter-black text-[13.5px] leading-[17px] text-navy">{title}</Text>
        <Text className="mt-[3px] text-[11px] text-faint">{sub}</Text>
      </View>
    </Pressable>
  );
}

// Photo card with a dark gradient so white text stays legible (air options, care banner).
export function PhotoCard({ img, height, onPress, children, className = '' }) {
  return (
    <Pressable onPress={onPress} className={`overflow-hidden rounded-2xl active:opacity-90 ${className}`} style={{ height }}>
      <ImageBackground source={IMAGES[img]} resizeMode="cover" style={{ flex: 1 }}>
        <LinearGradient
          colors={['rgba(13,35,64,0.1)', 'rgba(13,35,64,0.3)', 'rgba(13,35,64,0.85)']}
          locations={[0, 0.5, 1]}
          style={{ flex: 1, justifyContent: 'flex-end', padding: 16 }}
        >
          {children}
        </LinearGradient>
      </ImageBackground>
    </Pressable>
  );
}

export function DocRow({ label, meta, onPress, className = '' }) {
  return (
    <Pressable onPress={onPress} className={`mb-2.5 flex-row items-center gap-2.5 rounded-[14px] border border-line bg-white p-3 active:opacity-80 ${className}`}>
      <View className="h-[34px] w-[34px] items-center justify-center rounded-[9px] bg-[#FDECEC]">
        <FileText size={16} color="#D64545" />
      </View>
      <View className="flex-1">
        <Text className="font-inter-bold text-[13.5px]">{label}</Text>
        <Text className="text-[11.5px] text-faint">{meta}</Text>
      </View>
      <Download size={15} color="#1A73E8" />
    </Pressable>
  );
}

export function Toast() {
  const { toastMsg } = useApp();
  const insets = useSafeAreaInsets();
  if (!toastMsg) return null;
  return (
    <View pointerEvents="none" className="absolute left-0 right-0 items-center" style={{ bottom: 90 + insets.bottom }}>
      <View className="rounded-full border border-[#223047] bg-ink px-[18px] py-2.5">
        <Text className="font-inter-semibold text-[13.5px] text-white">{toastMsg}</Text>
      </View>
    </View>
  );
}
