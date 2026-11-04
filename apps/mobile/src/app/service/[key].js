import { useEffect, useState } from 'react';
import { Image, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { Check } from 'lucide-react-native';
import { useApp } from '../../state/AppContext';
import SERVICES from '../../data/services.json';
import { IMAGES } from '../../data/images';
import { apiGet } from '../../lib/api';
import { Body, Screen, TopBar } from '../../components/layout';
import { Button, Card, Heading, SectionLabel, Text } from '../../components/ui';

export default function ServiceDetail() {
  const { t, toast, resetDraft, isCorporate, draft } = useApp();
  const { key } = useLocalSearchParams();
  const local = SERVICES[key] || SERVICES.air;
  // stats + img aren't in the backend yet, so those stay bundled locally; everything
  // admin can actually edit (name/description/provides) comes live, merged on top.
  const [live, setLive] = useState(null);

  useEffect(() => {
    apiGet(`/services/${key}`)
      .then(({ service }) => setLive(service))
      .catch((err) => toast(err.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refetch only when the key changes
  }, [key]);

  const title = live?.name || local.title;
  const desc = live?.description || local.desc;
  const features = live?.provides?.length ? live.provides : local.features;

  // Corporates submit through their own Case form (/corporate/cases), never the
  // patient-only /requests flow — that endpoint rejects non-patient tokens outright.
  const start = () => {
    if (isCorporate) { router.push('/corporate-new-case'); return; }
    // Picking another service from inside the request form: keep the patient, and come back
    // to the form already open instead of stacking a second copy of it.
    const swapping = draft.changingService;
    resetDraft(key);
    if (swapping) router.dismissTo('/request/step1');
    else router.push('/request/step1');
  };

  return (
    <Screen>
      <TopBar title={t('service_detail_title')} />
      <Body contentClassName="p-[22px]">
        <View className="mb-5 min-h-[180px] flex-1 overflow-hidden rounded-2xl bg-primary">
          <Image source={IMAGES[local.img]} style={{ position: 'absolute', width: '100%', height: '100%' }} resizeMode="cover" />
        </View>
        <Heading className="text-[20.5px]">{title}</Heading>
        <Text className="mt-2.5 text-[14px] leading-[22px] text-muted">{desc}</Text>
        <View className="mt-[18px] flex-row gap-2">
          {local.stats.map((st) => (
            <Card key={st.label} className="flex-1 items-center justify-center px-1.5 py-3">
              <Text className="font-inter-black text-[15px] text-primary">{st.value}</Text>
              <Text className="mt-0.5 text-center text-[10px] text-faint">{st.label}</Text>
            </Card>
          ))}
        </View>
        <Card className="mt-[18px]">
          <SectionLabel className="mb-3">{t('we_provide_label')}</SectionLabel>
          <View className="gap-[9px]">
            {features.map((f) => (
              <View key={f} className="flex-row items-start gap-2">
                <View className="mt-px"><Check size={15} color="#2FA84F" strokeWidth={2.4} /></View>
                <Text className="flex-1 text-[13.5px]">{f}</Text>
              </View>
            ))}
          </View>
        </Card>
        <Button title={t('request_this_service_btn')} onPress={start} className="mt-5" />
      </Body>
    </Screen>
  );
}
