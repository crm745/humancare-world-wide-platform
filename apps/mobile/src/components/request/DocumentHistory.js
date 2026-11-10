import { View } from 'react-native';
import { reviewState } from '../../lib/requestDocuments';
import { historyRows } from '../../lib/documentHistoryView';
import { Card, Text } from '../ui';

// Every document of a request in the review workflow, earlier versions included: name, size and date, how
// each stands, why one was rejected, and which version replaced which. Display only: the rows cannot be
// opened or downloaded, and show nothing about where a file is stored. Nothing for older requests and
// other services.
export default function DocumentHistory({ request, className = 'mt-5' }) {
  if (reviewState(request) === null) return null;
  const rows = historyRows(request.requestDocuments);
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
