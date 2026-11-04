import { useMemo, useState } from 'react';
import { FlatList, Modal, Pressable, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Check, ChevronDown, Search, X } from 'lucide-react-native';
import { useApp } from '../state/AppContext';
import { dialOf, nameOf, searchCountries } from '../lib/phoneCountry';
import { isValidMobileNumber } from '../lib/validators';
import { FieldLabel, Input, Text } from './ui';

// A full-height list of every country with a search box. Typing a name ("emir") or a dial code
// ("971", "+1") narrows it. `selected` is an ISO code, and the row for it is ticked; countries
// that share a dial code (+1, +7, +44) are separate rows, so the choice is a country, not a code.
function CountryPicker({ visible, title, selected, onPick, onClose }) {
  const { t, isRTL } = useApp();
  const insets = useSafeAreaInsets();
  const [query, setQuery] = useState('');
  const results = useMemo(() => searchCountries(query), [query]);
  const close = () => { setQuery(''); onClose(); };
  const pick = (code) => { setQuery(''); onPick(code); };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={close} statusBarTranslucent>
      <View className="flex-1 bg-white" style={{ paddingTop: insets.top, paddingBottom: insets.bottom, direction: isRTL ? 'rtl' : 'ltr' }}>
        <View className="flex-row items-center justify-between border-b border-line px-[18px] pb-3 pt-4">
          <Text className="font-inter-black text-[17px] text-navy" accessibilityRole="header">{title}</Text>
          <Pressable onPress={close} accessibilityRole="button" accessibilityLabel={t('country_picker_close')} className="h-11 w-11 items-center justify-center rounded-full bg-soft active:opacity-70">
            <X size={18} color="#45526B" />
          </Pressable>
        </View>
        <View className="mx-[18px] my-3 flex-row items-center gap-2 rounded-[10px] border-[1.5px] border-field bg-input px-3">
          <Search size={16} color="#97A4B8" />
          <TextInput
            value={query} onChangeText={setQuery} autoCorrect={false} autoCapitalize="none" returnKeyType="search"
            accessibilityLabel={t('country_picker_search')} placeholder={t('country_picker_search')} placeholderTextColor="#97A4B8"
            className="min-h-[46px] flex-1 font-inter text-[15px] text-ink"
          />
        </View>
        <FlatList
          data={results} keyExtractor={(c) => c.code} keyboardShouldPersistTaps="handled"
          initialNumToRender={20} windowSize={10}
          ListEmptyComponent={<Text className="px-[18px] py-6 text-center text-[14px] text-muted">{t('country_picker_empty')}</Text>}
          renderItem={({ item }) => {
            const on = item.code === selected;
            return (
              <Pressable
                onPress={() => pick(item.code)} accessibilityRole="button" accessibilityState={{ selected: on }}
                accessibilityLabel={`${item.name}, ${item.dial}`}
                className={`min-h-[48px] flex-row items-center gap-3 border-b border-divider px-[18px] py-2.5 active:bg-soft ${on ? 'bg-primary-soft' : ''}`}
              >
                <Text className="flex-1 text-[15px] text-navy">{item.name}</Text>
                <Text className="text-[14px] text-muted">{item.dial}</Text>
                {on ? <Check size={16} color="#1A73E8" strokeWidth={2.6} /> : <View className="w-4" />}
              </Pressable>
            );
          }}
        />
      </View>
    </Modal>
  );
}

// "Nationality" with the phone number under it. Nationality opens the country list; the calling
// code ("+91 ▾") opens the same list and is editable, because many people live abroad and use a
// local number. The parent keeps the state (see lib/phoneCountry.js for the rules).
export function NationalityPhoneFields({ nationality, phoneCountry, phone, onNationality, onPhoneCountry, onPhone, showErrors }) {
  const { t } = useApp();
  const [picking, setPicking] = useState(null); // 'nationality' | 'phone' | null
  const dial = dialOf(phoneCountry);
  const phoneBad = phone ? !isValidMobileNumber(phone, dial) : showErrors;

  return (
    <>
      <View>
        <FieldLabel large required>{t('field_nationality')}</FieldLabel>
        <Pressable
          onPress={() => setPicking('nationality')} accessibilityRole="button"
          accessibilityLabel={`${t('field_nationality')}, ${nationality ? nameOf(nationality) : t('nationality_placeholder')}`}
          className="min-h-[52px] flex-row items-center justify-between gap-2 rounded-[10px] border-[1.5px] border-field bg-input px-3 py-3 active:opacity-80"
        >
          <Text className={`flex-1 text-[16.5px] ${nationality ? '' : 'text-faint'}`} numberOfLines={1}>{nationality ? nameOf(nationality) : t('nationality_placeholder')}</Text>
          <ChevronDown size={16} color="#97A4B8" />
        </Pressable>
        {showErrors && !nationality ? <Text className="mt-1 text-[12px] text-danger">{t('nationality_required')}</Text> : null}
      </View>

      <View>
        <FieldLabel large required>{t('field_mobile_number')}</FieldLabel>
        <View className="flex-row gap-2">
          <Pressable
            onPress={() => setPicking('phone')} accessibilityRole="button"
            accessibilityLabel={`${t('country_code_label')}, ${nameOf(phoneCountry)} ${dial}`}
            className="min-h-[52px] min-w-[96px] flex-row items-center justify-center gap-1 rounded-[10px] border-[1.5px] border-field bg-input px-3 active:opacity-80"
          >
            <Text className="text-[16.5px]">{dial}</Text>
            <ChevronDown size={16} color="#97A4B8" />
          </Pressable>
          <Input large className="flex-1" placeholder="Mobile number" keyboardType="phone-pad" accessibilityLabel={t('field_mobile_number')} value={phone} onChangeText={onPhone} />
        </View>
        {phoneBad ? <Text className="mt-1 text-[12px] text-danger">{phone ? t('phone_invalid_for_country') : t('phone_required')}</Text> : null}
      </View>

      <CountryPicker
        visible={picking === 'nationality'} title={t('field_nationality')} selected={nationality}
        onPick={(code) => { setPicking(null); onNationality(code); }} onClose={() => setPicking(null)}
      />
      <CountryPicker
        visible={picking === 'phone'} title={t('country_code_label')} selected={phoneCountry}
        onPick={(code) => { setPicking(null); onPhoneCountry(code); }} onClose={() => setPicking(null)}
      />
    </>
  );
}
