import { useApp } from '../state/AppContext';
import { Body, Screen, TopBar } from '../components/layout';
import { ServiceGrid } from '../components/ServiceGrid';

export default function SelectService() {
  const { t } = useApp();
  return (
    <Screen>
      <TopBar title={t('select_service_title')} />
      <Body contentClassName="px-[18px] py-[18px]">
        <ServiceGrid />
      </Body>
    </Screen>
  );
}
