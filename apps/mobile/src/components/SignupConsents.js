import { View } from 'react-native';
import { router } from 'expo-router';
import { useApp } from '../state/AppContext';
import { Consent, Text } from './ui';

// The one sign-up consent, shared by the sign-up form and the Google/Apple "complete your
// profile" screen so both show the same wording: agreeing to the Terms and Conditions and the
// Privacy Policy (both links open their page). It is required. Changing this text means bumping
// CONSENT_VERSION in the backend's auth.controller.js.
// `value` is true once the box is ticked.
export function SignupConsents({ value, onChange }) {
  const { t } = useApp();
  const link = (label, path) => <Text className="font-inter-bold text-primary" onPress={() => router.push(path)}>{label}</Text>;

  return (
    <View className="mt-[18px]">
      <Consent on={value} onToggle={() => onChange(!value)}>
        <Text className="text-[13.5px] leading-5 text-muted">
          By submitting the above information, you agree to our {link(t('register_terms_link'), '/terms')} and {link(t('privacy_title'), '/privacy')}.
        </Text>
      </Consent>
    </View>
  );
}

// What the backend expects under `consents`: only what was shown and agreed to.
export function consentsBody(agreed) {
  return { termsPrivacy: agreed };
}
