import { useState } from 'react';
import { Pressable, View } from 'react-native';
import { Redirect, router } from 'expo-router';
import { Check, TriangleAlert } from 'lucide-react-native';
import { useApp } from '../state/AppContext';
import { apiPost } from '../lib/api';
import { codeStepFrom, setAuthStep } from '../lib/authFlow';
import { Body, Screen, TopBar } from '../components/layout';
import { Button, Card, Text } from '../components/ui';

// Delete account (Profile → Delete account), PATIENT accounts only (a corporate account is sent back to Profile; the server refuses it too).
// Step 1 of 2. It explains, in plain words, what happens (permanent; sign-in removed; some request, case and document records may be kept where the law or
// operations require it; uploaded files and partner records are not deleted automatically), then sends a code to the account's own email (or its mobile when the email
// was never verified) and moves on to enter it (delete-account-otp.js). No password is asked for, for any account. Nothing is deleted here, and one tap can never
// delete anything: the person must tick "I understand" and press a separate button, then enter the code. A patient with requests still in progress is told so and
// pointed to support.
const BULLETS = ['del_item_personal', 'del_item_records', 'del_item_files', 'del_item_active'];

export default function DeleteAccount() {
  const { t, toast, isCorporate } = useApp();
  const [understood, setUnderstood] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [blocked, setBlocked] = useState(null); // the number of requests in progress, when that is what stopped it

  if (isCorporate) return <Redirect href="/profile" />;

  const ready = understood;

  const submit = async () => {
    if (!ready || busy) return; // a second tap while the first request runs does nothing
    setError(null);
    setBlocked(null);
    setBusy(true);
    try {
      const data = await apiPost('/auth/me/delete/start', {});
      setAuthStep('delete-account-otp', codeStepFrom(data));
      router.push('/delete-account-otp');
    } catch (err) {
      if (err.code === 'active_requests') setBlocked((err.data && err.data.activeRequests) || 1);
      else if (err.status && err.status < 500) setError(err.message);
      else toast(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <TopBar title={t('prof_delete')} />
      <Body contentClassName="p-[18px]">
        <View style={{ gap: 16 }}>
          <Card className="p-[18px]" style={{ borderColor: '#F3C4C4', backgroundColor: '#FFF6F6' }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <TriangleAlert size={22} color="#C53030" strokeWidth={2} />
              <Text accessibilityRole="header" className="flex-1 font-inter-black text-[16px] text-danger-dark">{t('del_warning_title')}</Text>
            </View>
            <Text className="mt-2.5 text-[14px] leading-[21px] text-ink">{t('del_warning_body')}</Text>
          </Card>

          <Card className="p-[18px]">
            <View style={{ gap: 12 }}>
              {BULLETS.map((key) => (
                <View key={key} style={{ flexDirection: 'row', gap: 10 }}>
                  <Text className="text-[14px] leading-[21px] text-muted">{'•'}</Text>
                  <Text className="flex-1 text-[13.5px] leading-[21px] text-muted">{t(key)}</Text>
                </View>
              ))}
            </View>
          </Card>

          {blocked ? (
            <Card className="p-[18px]" style={{ borderColor: '#F5D9A6', backgroundColor: '#FFFAF0' }}>
              <Text accessibilityRole="header" className="font-inter-black text-[15px] text-navy">{t('del_blocked_title')}</Text>
              <Text className="mt-2 text-[13.5px] leading-[21px] text-muted">{t('del_blocked_body', { n: blocked })}</Text>
              <Button title={t('del_contact_support')} variant="outline" className="mt-3.5" onPress={() => router.push('/help-support')} />
            </Card>
          ) : null}

          {error ? <Text className="text-[12px] text-danger">{error}</Text> : null}

          <Pressable
            onPress={() => setUnderstood((value) => !value)} accessibilityRole="checkbox" accessibilityState={{ checked: understood }} accessibilityLabel={t('del_confirm_check')}
            style={{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 48 }}
          >
            <View
              style={{
                width: 24, height: 24, borderRadius: 7, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center',
                borderColor: understood ? '#C53030' : '#B8C2D3', backgroundColor: understood ? '#C53030' : '#FFFFFF',
              }}
            >
              {understood ? <Check size={16} color="#FFFFFF" strokeWidth={3} /> : null}
            </View>
            <Text className="flex-1 text-[14px] leading-[20px] text-ink">{t('del_confirm_check')}</Text>
          </Pressable>

          <Button title={t('del_continue')} variant="danger" large dimmed={!ready} loading={busy} onPress={submit} />
          <Button title={t('del_cancel')} variant="ghost" onPress={() => router.back()} />
        </View>
      </Body>
    </Screen>
  );
}
