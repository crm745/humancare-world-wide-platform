import { Text as NativeText, View } from 'react-native';
import { reviewState } from '../../lib/requestDocuments';
import { historyRows } from '../../lib/documentHistoryView';
import { Card, Text } from '../ui';
import { C, Card as DetailsCard, FONT, Section, WRAP } from './DetailsParts';

const STATUS_COLOR = {
  approved: '#0B6564', rejected: '#C53030', unsafe: '#C53030', scan_failed: '#C53030', awaiting_review: '#1A5FC4', checking: '#5B6B84',
};

// Every document of a request in the review workflow, earlier versions included: name, size and date, how
// each stands, why one was rejected, and which version replaced which. Display only: the rows cannot be
// opened or downloaded, and show nothing about where a file is stored. Nothing for older requests and
// other services.
export default function DocumentHistory({ request, className = 'mt-5', styled = false }) {
  if (reviewState(request) === null) return null;
  const rows = historyRows(request.requestDocuments);
  // Request Details draws it in its own card style (a section label over a card); Tracking keeps the card it always had.
  if (styled) {
    return (
      <Section title="Document history">
        <DetailsCard>
          {rows.length === 0 && <NativeText style={{ fontFamily: FONT[400], fontSize: 13, color: C.muted }}>No documents uploaded yet.</NativeText>}
          {rows.map((row, i) => (
            <View key={row.id} style={{ marginTop: i === 0 ? 0 : 12, paddingTop: i === 0 ? 0 : 12, borderTopWidth: i === 0 ? 0 : 1, borderTopColor: C.divider, opacity: row.superseded ? 0.6 : 1 }}>
              <View style={{ flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
                <NativeText numberOfLines={2} style={[{ flex: 1, minWidth: 0, fontFamily: FONT[700], fontSize: 13.5, lineHeight: 19, color: C.navy }, WRAP]}>{row.name}</NativeText>
                <NativeText style={{ flexShrink: 0, maxWidth: '45%', fontFamily: FONT[700], fontSize: 12, lineHeight: 16, color: STATUS_COLOR[row.status] || C.muted, textAlign: 'right' }}>{row.statusLabel}</NativeText>
              </View>
              {!!row.meta && <NativeText style={{ marginTop: 2, fontFamily: FONT[400], fontSize: 12, lineHeight: 16, color: C.muted }}>{row.meta}</NativeText>}
              {row.superseded && <NativeText style={{ marginTop: 2, fontFamily: FONT[400], fontSize: 12, lineHeight: 16, color: C.muted }}>Earlier version</NativeText>}
              {row.notes.map((note) => <NativeText key={note} style={[{ marginTop: 2, fontFamily: FONT[400], fontSize: 12, lineHeight: 16, color: C.muted }, WRAP]}>{note}</NativeText>)}
              {!!row.reason && <NativeText style={[{ marginTop: 6, fontFamily: FONT[400], fontSize: 12.5, lineHeight: 18, color: '#C53030' }, WRAP]}>{row.reason}</NativeText>}
              {!!row.guidance && <NativeText style={[{ marginTop: 6, fontFamily: FONT[400], fontSize: 12.5, lineHeight: 18, color: '#C53030' }, WRAP]}>{row.guidance}</NativeText>}
            </View>
          ))}
        </DetailsCard>
      </Section>
    );
  }
  return (
    <Card className={`p-[18px] ${className}`}>
      <Text className="font-inter-black text-[14.5px] text-navy">Document history</Text>
      {rows.length === 0 && <Text className="mt-2 text-[13px] text-faint">No documents uploaded yet.</Text>}
      {rows.map((row, i) => (
        <View key={row.id} className={`${i === 0 ? 'mt-3' : 'mt-3 border-t border-divider pt-3'} ${row.superseded ? 'opacity-60' : ''}`}>
          <View className="flex-row items-start justify-between gap-3">
            <Text className="min-w-0 flex-1 font-inter-bold text-[13.5px] text-navy" numberOfLines={2}>{row.name}</Text>
            <Text className={`font-inter-bold text-[12px] ${row.statusClass}`}>{row.statusLabel}</Text>
          </View>
          {!!row.meta && <Text className="mt-0.5 text-[12px] text-faint">{row.meta}</Text>}
          {row.superseded && <Text className="mt-0.5 text-[12px] text-muted">Earlier version</Text>}
          {row.notes.map((note) => <Text key={note} className="mt-0.5 text-[12px] text-muted">{note}</Text>)}
          {!!row.reason && <Text className="mt-1.5 text-[12.5px] leading-[18px] text-danger">{row.reason}</Text>}
          {!!row.guidance && <Text className="mt-1.5 text-[12.5px] leading-[18px] text-danger">{row.guidance}</Text>}
        </View>
      ))}
    </Card>
  );
}
