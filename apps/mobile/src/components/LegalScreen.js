import { useApp } from '../state/AppContext';
import { Body, Screen, TopBar } from './layout';
import { Text } from './ui';

// Terms and Privacy: numbered sections of heading + paragraph. The last section
// ends with the ops email highlighted, as in the prototype.
export function LegalScreen({ titleKey, sections }) {
  const { t } = useApp();
  return (
    <Screen>
      <TopBar title={t(titleKey)} />
      <Body contentClassName="p-[18px]">
        <Text className="mb-5 text-[12px] text-faint">Last updated: 1 January 2026</Text>
        {sections.map(([heading, body], i) => (
          <Text key={heading} className="mb-5">
            <Text className="font-inter-black text-[14px] text-navy">{`${i + 1}. ${heading}\n`}</Text>
            <Text className="text-[13.5px] leading-[22px] text-muted">{body}</Text>
            {i === sections.length - 1 && <Text className="font-inter-bold text-[13.5px] text-primary">ops@humancareworldwide.com.</Text>}
          </Text>
        ))}
      </Body>
    </Screen>
  );
}
