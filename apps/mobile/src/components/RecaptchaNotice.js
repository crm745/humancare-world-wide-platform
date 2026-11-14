import { Linking, Platform, View } from 'react-native';
import { useApp } from '../state/AppContext';
import { RECAPTCHA_PRIVACY_URL, RECAPTCHA_TERMS_URL } from '../lib/recaptcha';
import { Text } from './ui';

const PRIVACY = '\u0001';
const TERMS = '\u0002';

// Google's reCAPTCHA notice, which it requires wherever its badge is hidden: "This site is protected by reCAPTCHA and the Google
// Privacy Policy and Terms of Service apply." Shown (web only) on the screens that send a code through Firebase, which is
// where reCAPTCHA runs. The two names are links to Google's pages, wherever the language puts them.
export function RecaptchaNotice() {
  const { t } = useApp();
  if (Platform.OS !== 'web') return null;
  const pieces = t('recaptcha_notice', { privacy: PRIVACY, terms: TERMS }).split(/([\u0001\u0002])/);
  return (
    <View style={{ marginTop: 18, paddingHorizontal: 8 }}>
      <Text className="text-center text-[11.5px] leading-4 text-faint">
        {pieces.map((piece, i) => {
          if (piece === PRIVACY || piece === TERMS) {
            const privacy = piece === PRIVACY;
            return (
              <Text
                key={i} accessibilityRole="link" className="text-[11.5px] text-primary underline"
                onPress={() => Linking.openURL(privacy ? RECAPTCHA_PRIVACY_URL : RECAPTCHA_TERMS_URL)}
              >
                {t(privacy ? 'recaptcha_privacy' : 'recaptcha_terms')}
              </Text>
            );
          }
          return piece;
        })}
      </Text>
    </View>
  );
}
