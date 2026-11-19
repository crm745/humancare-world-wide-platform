import { useCallback, useRef, useState } from 'react';
import { View } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { useApp } from '../../state/AppContext';
import { useQuotation } from '../../lib/useQuotation';
import { quotationAmount, REASON_MAX, validateRejectionReason } from '../../lib/quotationView';
import { formatDisplayDate } from '../../lib/requestShape';
import { Spinner } from '../Spinner';
import { Sheet } from '../widgets';
import { Button, Card, Field, InfoRow, Text } from '../ui';

const TONE = {
  available: 'bg-warning-soft text-warning',
  accepted: 'bg-success-soft text-success',
  rejected: 'bg-cancel-soft text-cancel',
  expired: 'bg-cancel-soft text-cancel',
  unavailable: 'bg-primary-soft text-primary-dark',
};

function StatusChip({ kind, t }) {
  const [bg, fg] = (TONE[kind] || TONE.unavailable).split(' ');
  return (
    <View className={`rounded-full px-2.5 py-1 ${bg}`}>
      <Text className={`font-inter-black text-[11px] uppercase tracking-wide ${fg}`}>{t(`quotation_status_${kind}`)}</Text>
    </View>
  );
}

const fill = (text, values) => Object.entries(values).reduce((out, [key, value]) => out.replace(`{${key}}`, value), text);

// The patient's quotation (Private Charter): the ONE active published version of this request, its PDF, and Accept / Reject.
// The backend decides what is allowed (`canDecide`, `expired`); this only presents it. Accepting and rejecting both ask for confirmation first; a
// rejection needs a reason. A decision is final: afterwards the card shows the confirmed decision and offers nothing to change.
// Renders nothing when the server says this request has no quotation feature (status 404).
export default function QuotationSection({ request, onChanged, className = 'mt-5' }) {
  const { t, toast } = useApp();
  const q = useQuotation(request ? request.id : null);
  const [sheet, setSheet] = useState(null); // null | 'accept' | 'reject' | 'rejectConfirm'
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);
  const [problem, setProblem] = useState(null); // an i18n key shown inside the open sheet
  const first = useRef(true);

  // Coming back to the screen (from the PDF, from another screen) shows what the server now holds.
  useFocusEffect(useCallback(() => {
    if (first.current) { first.current = false; return; }
    q.reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reload is stable per request
  }, [q.reload]));

  if (q.status === 'hidden') return null;
  const { kind, quotation, lastDecision } = q.state;
  const amount = quotationAmount(quotation || lastDecision);

  const closeSheet = () => { if (q.busy) return; setSheet(null); setProblem(null); };
  const openSheet = (name) => { setProblem(null); setSheet(name); };
  const afterDecision = (outcome, doneKey) => {
    if (outcome.busy) return;
    if (outcome.ok) {
      setSheet(null); setReason(''); setTouched(false); setProblem(null);
      toast(t(outcome.already ? 'quotation_done_already' : doneKey));
      if (onChanged) onChanged(); // reload the request, so the sections below show what the server now holds
    } else if (outcome.stale) {
      setSheet(null); setProblem(null);
      toast(t(outcome.key)); // the card has been reloaded: it shows what the server holds now
    } else {
      setProblem(outcome.key);
    }
  };

  const accept = async () => afterDecision(await q.accept(quotation), 'quotation_done_accepted');
  const reject = async () => {
    const check = validateRejectionReason(reason);
    if (!check.ok) { setSheet('reject'); setTouched(true); return; }
    afterDecision(await q.reject(quotation, check.value), 'quotation_done_rejected');
  };
  const openPdf = async () => {
    const outcome = await q.download(quotation, request.referenceNumber);
    if (!outcome.ok && !outcome.busy) toast(t(outcome.key));
  };
  const reasonCheck = validateRejectionReason(reason);

  let body = null;
  if (q.status === 'loading') {
    body = <View className="items-center py-5"><Spinner size={22} color="#1A73E8" trackColor="#E7F0FE" /></View>;
  } else if (q.status === 'error') {
    body = (
      <View>
        <Text className="text-[13px] leading-[19px] text-faint">{t('quotation_load_failed')}</Text>
        <Button title={t('quotation_retry')} variant="outline" onPress={q.reload} className="mt-3" />
      </View>
    );
  } else if (kind === 'none') {
    body = <Text className="text-[13px] leading-[19px] text-faint">{t('quotation_empty')}</Text>;
  } else if (kind === 'rejected') {
    body = (
      <View>
        <View className="mb-3 flex-row items-center justify-between gap-2"><Text className="font-inter-bold text-[13.5px] text-navy">{fill(t('quotation_version'), { n: lastDecision.versionNumber })}</Text><StatusChip kind="rejected" t={t} /></View>
        <Text className="text-[13px] leading-[19px] text-faint">{fill(t('quotation_rejected_msg'), { n: lastDecision.versionNumber })}</Text>
      </View>
    );
  } else {
    body = (
      <View>
        <View className="mb-2.5 flex-row items-center justify-between gap-2">
          <Text className="font-inter-bold text-[13.5px] text-navy">{fill(t('quotation_version'), { n: quotation.versionNumber })}</Text>
          <StatusChip kind={kind} t={t} />
        </View>
        <InfoRow last={!quotation.validUntil} label={t('quotation_amount')} value={amount} />
        {!!quotation.validUntil && <InfoRow last label={t('quotation_valid_until')} value={formatDisplayDate(quotation.validUntil)} />}

        {kind === 'accepted' && <Text accessibilityLiveRegion="polite" className="mt-2.5 text-[12.5px] leading-[18px] text-success">{fill(t('quotation_accepted_msg'), { date: formatDisplayDate(quotation.decidedAt) })}</Text>}
        {kind === 'expired' && <Text className="mt-2.5 text-[12.5px] leading-[18px] text-cancel">{t('quotation_expired_msg')}</Text>}
        {kind === 'unavailable' && <Text className="mt-2.5 text-[12.5px] leading-[18px] text-faint">{t('quotation_unavailable_msg')}</Text>}

        {quotation.fileAvailable && (
          <Button title={q.fileBusy ? t('quotation_downloading') : t('quotation_view_pdf')} variant="outline" loading={q.fileBusy} disabled={q.fileBusy} onPress={openPdf} className="mt-3.5" />
        )}
        {kind === 'available' && (
          <View className="mt-3 flex-row gap-2.5">
            <Button title={t('quotation_reject')} variant="danger" disabled={q.busy} onPress={() => openSheet('reject')} className="flex-1" />
            <Button title={t('quotation_accept')} disabled={q.busy} onPress={() => openSheet('accept')} className="flex-1" />
          </View>
        )}
      </View>
    );
  }

  return (
    <>
      <Card className={`p-[18px] ${className}`}>
        <Text className="mb-3.5 font-inter-black text-[14.5px] text-navy">{t('quotation_title')}</Text>
        {body}
      </Card>

      {quotation && kind === 'available' && (
        <>
          <Sheet visible={sheet === 'accept'} onClose={closeSheet} title={t('quotation_accept_title')}>
            <Text className="mb-4 text-[13.5px] leading-[20px] text-ink">{fill(t('quotation_accept_body'), { n: quotation.versionNumber, amount })}</Text>
            {!!problem && <Text accessibilityLiveRegion="polite" className="mb-3 text-[12.5px] text-danger">{t(problem)}</Text>}
            <Button title={t('quotation_accept_confirm')} loading={q.busy} disabled={q.busy} onPress={accept} />
            <Button title={t('quotation_cancel')} variant="ghost" disabled={q.busy} onPress={closeSheet} className="mt-2.5" />
          </Sheet>

          <Sheet visible={sheet === 'reject'} onClose={closeSheet} title={t('quotation_reject_title')}>
            <Field
              label={t('quotation_reject_reason_label')}
              required
              multiline
              value={reason}
              onChangeText={setReason}
              onBlur={() => setTouched(true)}
              maxLength={REASON_MAX}
              placeholder={t('quotation_reject_reason_ph')}
              error={touched && !reasonCheck.ok ? t(reasonCheck.key) : undefined}
            />
            <Button title={t('quotation_reject_continue')} onPress={() => { setTouched(true); if (reasonCheck.ok) openSheet('rejectConfirm'); }} className="mt-4" />
            <Button title={t('quotation_cancel')} variant="ghost" onPress={closeSheet} className="mt-2.5" />
          </Sheet>

          <Sheet visible={sheet === 'rejectConfirm'} onClose={closeSheet} title={t('quotation_reject_confirm_title')}>
            <Text className="mb-2.5 text-[13.5px] leading-[20px] text-ink">{fill(t('quotation_reject_confirm_body'), { n: quotation.versionNumber, amount })}</Text>
            <Text className="mb-4 rounded-xl bg-input p-3 text-[13px] leading-[19px] text-ink">{reasonCheck.ok ? reasonCheck.value : ''}</Text>
            {!!problem && <Text accessibilityLiveRegion="polite" className="mb-3 text-[12.5px] text-danger">{t(problem)}</Text>}
            <Button title={t('quotation_reject_confirm')} variant="danger" loading={q.busy} disabled={q.busy} onPress={reject} />
            <Button title={t('quotation_back')} variant="ghost" disabled={q.busy} onPress={() => openSheet('reject')} className="mt-2.5" />
          </Sheet>
        </>
      )}
    </>
  );
}
