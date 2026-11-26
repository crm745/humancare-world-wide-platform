import { View } from 'react-native';
import { router } from 'expo-router';
import { useApp } from '../state/AppContext';
import { SERVICE_TILES } from '../data/mock';
import { ServiceTile } from './widgets';

export function openService(key) {
  router.push(`/service/${key}`);
}

// What picking a service does where the service list can be reached from the request form ("Change" on the form). Normally it opens that service's page (openService). While the person is changing the
// service of the request they are filling (draft.changingService), the pick IS the choice: the draft is kept for the new service (resetDraft keeps the patient, trip and medical details: lib/requestForm.js
// draftForService) and the form that was already open comes back to the front (the same as "start" on the service page does), instead of showing the service page first.
export function useOpenService() {
  const { draft, resetDraft } = useApp();
  return (key) => {
    if (draft.changingService) {
      resetDraft(key);
      router.dismissTo('/request/step1');
      return;
    }
    openService(key);
  };
}

// 2-column grid of the 7 services, shared by Home and Select a Service.
export function ServiceGrid() {
  const { t } = useApp();
  return (
    <View className="flex-row flex-wrap justify-between gap-y-3">
      {SERVICE_TILES.map((s) => (
        <ServiceTile
          key={s.key}
          img={s.img}
          title={t(s.title)}
          sub={t(s.sub)}
          onPress={() => (s.route ? router.push(s.route) : openService(s.key))}
        />
      ))}
    </View>
  );
}
