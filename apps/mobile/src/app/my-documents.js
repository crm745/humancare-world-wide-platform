import { useState } from 'react';
import { Pressable, View } from 'react-native';
import { router } from 'expo-router';
import { Search } from 'lucide-react-native';
import { useApp } from '../state/AppContext';
import { apiGet } from '../lib/api';
import { openDocumentPreview } from '../lib/documentPreview';
import { countLabel, filterDocuments } from '../lib/documentsView';
import { TRACKING_PALETTE as P } from '../lib/tracking/palette';
import { Body, Screen, TopBar } from '../components/layout';
import { Input, Text } from '../components/ui';
import { AppRefreshControl } from '../components/AppRefreshControl';
import { Reveal } from '../components/skeleton/Reveal';
import { useSkeletonGate } from '../components/skeleton/hooks';
import { RowsSkeleton } from '../components/skeleton/screens';
import { useResource } from '../lib/useResource';
import { DocumentCard } from '../components/documents/DocumentCard';

// My Documents: every document attached to the patient's cases, from GET /requests/me/documents (unchanged). Each card
// shows the file name, its type and size, the case reference and when it was added to the case; tapping it opens the in-app preview
// (app/document-preview.js), which loads it with progress, shows an error with Try again if it cannot, and has its own Share button.
export default function MyDocuments() {
  const { t, toast } = useApp();
  const [query, setQuery] = useState('');

  // Loaded the way every data screen loads (lib/useResource.js): a shimmer skeleton on the first load only, what an earlier visit loaded
  // shows at once and refreshes quietly, "Try again" if the first load fails, and pull-to-refresh with the list staying on screen.
  const { data, loading, error, reload: retry, onRefresh, refreshing, highlight } = useResource({
    key: 'my-documents',
    fetcher: () => apiGet('/requests/me/documents').then(({ documents }) => documents || []),
    idsOf: (list) => list.map((d) => d.id),
    onRefreshError: () => toast(t('sk_refresh_failed')),
  });
  const docs = data || [];
  const failed = Boolean(error) && !data;
  const gate = useSkeletonGate(loading);

  // A tap opens the preview, never the share sheet. A double tap opens one preview (lib/documentPreview.js).
  const start = (doc) => { openDocumentPreview(router.push, doc); };

  const shown = filterDocuments(docs, query);

  return (
    <Screen>
      <TopBar title={t('my_documents')} />
      <Body contentClassName="px-[18px] py-4" refreshControl={<AppRefreshControl refreshing={refreshing} onRefresh={onRefresh} />}>
        {loading && gate.visible ? <RowsSkeleton label={t('sk_loading_documents')} count={5} lines={2} trailing /> : null}

        {!loading && failed ? (
          <View className="items-center px-5 py-[50px]">
            <Text className="text-center font-inter-bold text-[14px] text-navy">{t('docs_load_failed')}</Text>
            <Pressable accessibilityRole="button" accessibilityLabel={t('docs_try_again')} onPress={retry} className="mt-4 min-h-[44px] justify-center rounded-xl px-6 active:opacity-85" style={{ backgroundColor: P.brand }}>
              <Text className="font-inter-bold text-[14px] text-white">{t('docs_try_again')}</Text>
            </Pressable>
          </View>
        ) : null}

        {!loading && !failed && docs.length === 0 ? (
          <View className="items-center px-5 py-[50px]">
            <Text className="text-center font-inter-bold text-[14px] text-navy">{t('docs_empty_title')}</Text>
            <Text className="mt-1.5 text-center text-[12.5px] text-faint">{t('docs_empty_sub')}</Text>
          </View>
        ) : null}

        {!loading && !failed && docs.length > 0 ? (
          <Reveal animate={gate.wasShown}>
            <Text accessibilityRole="header" className="mb-2.5 font-inter-black text-[12px] uppercase tracking-wide text-faint">
              {`${t('lbl_medical_records')} (${countLabel(shown.length, docs.length)})`}
            </Text>
            <View className="mb-3 justify-center">
              <View className="absolute left-[11px] z-10"><Search size={15} color="#97A4B8" /></View>
              <Input placeholder={t('docs_search_ph')} value={query} onChangeText={setQuery} className="pl-8" autoCorrect={false} />
            </View>
            {shown.length === 0 ? (
              <View className="items-center px-5 py-10">
                <Text className="text-center text-[13px] text-faint">{t('docs_no_match')}</Text>
                <Pressable accessibilityRole="button" accessibilityLabel={t('docs_clear_search')} onPress={() => setQuery('')} className="mt-2 min-h-[44px] justify-center px-4">
                  <Text className="font-inter-bold text-[13px]" style={{ color: P.brand }}>{t('docs_clear_search')}</Text>
                </Pressable>
              </View>
            ) : (
              shown.map((d) => <DocumentCard key={d.id} doc={d} onPress={() => start(d)} t={t} isNew={highlight.includes(d.id)} />)
            )}
          </Reveal>
        ) : null}
      </Body>
    </Screen>
  );
}
