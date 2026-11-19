import { useEffect } from 'react';
import { View } from 'react-native';
import { router, useGlobalSearchParams } from 'expo-router';
import { useApp } from '../state/AppContext';
import { handlePaymentReturn } from '../lib/payments';
import { Screen } from '../components/layout';
import { Spinner } from '../components/Spinner';
import { Text } from '../components/ui';

// humancare://payment-return?invoice=761&result=submitted — where the hosted Checkout page sends the patient back to the
// app. The `result` word is INFORMATIONAL: it is remembered (so the message is right) and nothing more. This screen never
// shows "paid" and never changes anything: it sends the patient back to the request, whose invoice is then read from the
// backend (Request Details resumes the saved payment attempt and refreshes when focused).
export default function PaymentReturn() {
  const { t } = useApp();
  const params = useGlobalSearchParams();
  const invoice = Array.isArray(params.invoice) ? params.invoice[0] : params.invoice;
  const result = Array.isArray(params.result) ? params.result[0] : params.result;

  useEffect(() => {
    let live = true;
    (async () => {
      let requestId = null;
      try {
        ({ requestId } = await handlePaymentReturn(`humancare://payment-return?invoice=${encodeURIComponent(invoice || '')}&result=${encodeURIComponent(result || '')}`));
      } catch { /* the saved attempt is simply not updated; the invoice is still read from the backend */ }
      if (!live) return;
      // If Request Details is already underneath, return to it (it refreshes when focused); otherwise open the request.
      if (router.canGoBack()) router.back();
      else if (requestId != null) router.replace({ pathname: '/request-details', params: { id: String(requestId) } });
      else router.replace('/my-requests');
    })();
    return () => { live = false; };
  }, [invoice, result]);

  return (
    <Screen>
      <View className="flex-1 items-center justify-center gap-3.5 px-6">
        <Spinner size={30} color="#1A73E8" trackColor="#E7F0FE" />
        <Text className="text-center text-[14px] text-faint">{t('payment_returning')}</Text>
      </View>
    </Screen>
  );
}
