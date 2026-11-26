import { useApp } from '../state/AppContext';
import { Body, Screen, TopBar } from './layout';
import { Text } from './ui';

// Terms and Privacy: numbered sections of heading + paragraph (`sections` are [heading key, body key] pairs). The last section
// ends with a contact email highlighted (`email`: the ops address by default; the Privacy Policy passes the support address).
export function LegalScreen({ titleKey, sections, showUpdated = true, email = 'ops@humancareworldwide.com' }) {
  const { t } = useApp();
  return (
    <Screen>
      <TopBar title={t(titleKey)} />
      <Body contentClassName="p-[18px]">
        {showUpdated ? <Text className="mb-5 text-[12px] text-faint">{t('legal_last_updated')}</Text> : null}
        {sections.map(([headingKey, bodyKey], i) => (
          <Text key={headingKey} className="mb-5">
            <Text className="font-inter-black text-[14px] text-navy">{`${i + 1}. ${t(headingKey)}\n`}</Text>
            <Text className="text-[13.5px] leading-[22px] text-muted">{t(bodyKey)}</Text>
            {i === sections.length - 1 && <Text className="font-inter-bold text-[13.5px] text-primary">{`${email}.`}</Text>}
          </Text>
        ))}
      </Body>
    </Screen>
  );
}
