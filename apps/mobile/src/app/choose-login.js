import { View } from 'react-native';
import { router } from 'expo-router';
import { Building2, ShieldPlus, User } from 'lucide-react-native';
import { useApp } from '../state/AppContext';
import { OPS_EMAIL } from '../data/mock';
import { BackButton, Screen } from '../components/layout';
import { Card, Heading, Text } from '../components/ui';
import { COLORS } from '../theme/colors';

function RoleCard({ Icon, bg, color, title, sub, onPress, className = '' }) {
  return (
    <Card onPress={onPress} className={`flex-row items-center gap-3 ${className}`}>
      <View className={`h-[42px] w-[42px] items-center justify-center rounded-xl ${bg}`}><Icon size={20} color={color} /></View>
      <View>
        <Text className="font-inter-bold text-[14.5px]">{title}</Text>
        <Text className="mt-0.5 text-[12px] text-faint">{sub}</Text>
      </View>
    </Card>
  );
}

// Portal chooser (patient vs corporate). Not linked from the main flow; kept for parity with the prototype.
export default function ChooseLogin() {
  const { t } = useApp();
  return (
    <Screen padded>
      <BackButton className="mb-5 mt-[26px]" />
      <View className="flex-1 justify-center">
        <View className="mb-6 items-center">
          <View className="mb-3 h-[60px] w-[60px] items-center justify-center rounded-2xl bg-primary-soft"><ShieldPlus size={28} color={COLORS.primary} /></View>
          <Heading className="text-[20.5px]">{t('choose_login_title')}</Heading>
          <Text className="mt-2 max-w-[260px] text-center text-[13.5px] text-muted">{t('choose_login_sub')}</Text>
        </View>
        <RoleCard className="mb-3" Icon={User} bg="bg-primary-soft" color={COLORS.primary} title={t('role_patient_title')} sub={t('role_patient_sub')} onPress={() => router.push('/login')} />
        <RoleCard Icon={Building2} bg="bg-success-soft" color="#1E8E4A" title={t('role_corporate_title')} sub={t('role_corporate_sub')} onPress={() => router.push('/corporate-login')} />
      </View>
      <Text className="text-center text-[12.5px] text-faint">
        {t('need_credentials_q')} <Text className="font-inter-bold text-primary">{OPS_EMAIL}</Text>
      </Text>
    </Screen>
  );
}
