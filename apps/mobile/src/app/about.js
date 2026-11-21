import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useApp } from '../state/AppContext';
import { ABOUT_INTRO } from '../data/aboutContent';
import { fabClearance } from '../lib/sos';
import { Body, Screen, TopBar } from '../components/layout';
import { useSosFabVisible } from '../components/sos/hooks';
import { Text } from '../components/ui';

// About HumanCare (Profile > About HumanCare). It shows the company name, centred at the top (no logo), then the official introduction approved by HumanCare
// senior management: four paragraphs, exactly as supplied (data/aboutContent.js), in an open layout on the app's own background (no card, box, border or shadow). There
// is nothing else on the page: no contact details, legal links, version or other section. The title bar is the app's usual one (its back button and the translated "About" title). The introduction is English for now (translated separately).
// The root layout flips the screen for Arabic.
//
// Styling: the SAME values as the Privacy Policy page (components/LegalScreen.js, which Terms and Privacy share), so the two pages read alike:
//   - the scrolling Body with p-[18px] on every side (equal left and right);
//   - body text text-[13.5px] leading-[22px] text-muted, the font Text gives everywhere (the legal pages' body is regular weight, in the app's body font);
//   - mb-5 (20) after each paragraph, the legal pages' space between sections;
//   - the app's own screen background, as every screen.
// One addition the legal pages do not have: the floating call (SOS) button sits over the bottom of this screen, so while it shows, room is reserved under the last
// paragraph (exactly the button's zone: lib/sos.js fabClearance) and the last paragraph can always be scrolled clear above it.
const BODY_BOTTOM = 32; // the bottom padding the app's scrolling Body already adds (before the safe-area inset), so only the difference is added here

export default function About() {
  const { t } = useApp();
  const insets = useSafeAreaInsets();
  const fabShows = useSosFabVisible();
  // Room so the last paragraph clears the floating button: the button's zone measured from the bottom edge, less what Body already pads.
  const reserve = fabShows ? Math.max(0, fabClearance({ edge: 0, insetBottom: insets.bottom }) - (BODY_BOTTOM + insets.bottom)) : 0;

  return (
    <Screen>
      <TopBar title={t('prof_about')} />
      <Body contentClassName="p-[18px]">
        {/* The company name, centred above the introduction (the page has no logo). */}
        <View style={{ alignItems: 'center', marginBottom: 24 }}>
          <Text accessibilityRole="header" className="text-center font-inter-black text-[20px] text-navy">{t('about_name')}</Text>
        </View>
        {ABOUT_INTRO.paragraphs.map((paragraph, i) => (
          <Text key={paragraph} className="mb-5 text-[13.5px] leading-[22px] text-muted" selectable>{t(`about_p${i + 1}`)}</Text>
        ))}
        <View style={{ height: reserve }} />
      </Body>
    </Screen>
  );
}
