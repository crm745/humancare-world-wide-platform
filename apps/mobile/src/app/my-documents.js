import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform, Pressable, View } from 'react-native';
import { Search } from 'lucide-react-native';
import { useApp } from '../state/AppContext';
import { apiGet } from '../lib/api';
import { downloadDocument, downloadErrorInfo } from '../lib/download';
import { countLabel, createDownloadGuard, filterDocuments } from '../lib/documentsView';
import { TRACKING_PALETTE as P } from '../lib/tracking/palette';
import { Body, Screen, TopBar } from '../components/layout';
import { Input, Text } from '../components/ui';
import { LoadingState } from '../components/LoadingState';
import { DocumentCard } from '../components/documents/DocumentCard';

// My Documents: every document attached to the patient's cases, from GET /requests/me/documents (unchanged). Each card
// shows the file name, its type and size, the case reference and when it was added to the case; tapping it downloads
// the file with progress and a clear message if it cannot.
export default function MyDocuments() {
  const { t, toast } = useApp();
  const [docs, setDocs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState('');
  const [downloads, setDownloads] = useState({}); // per document id: { status, progress, message }
  // One download at a time per document, checked and set in one synchronous step (a state value would still say "idle"
  // for a second tap that arrives before the screen is redrawn). Other documents are independent.
  const guard = useRef(createDownloadGuard());

  const fetchDocs = useCallback(() => apiGet('/requests/me/documents')
    .then(({ documents }) => setDocs(documents || []))
    .catch((err) => { setFailed(true); toast(err.message); })
    .finally(() => setLoading(false)), [toast]);

  // eslint-disable-next-line react-hooks/exhaustive-deps -- fetch once on mount
  useEffect(() => { fetchDocs(); }, []);

  // Try again: back to the loading state, then the same request.
  const retry = () => {
    setLoading(true);
    setFailed(false);
    fetchDocs();
  };

  const setState = (id, next) => setDownloads((m) => ({ ...m, [id]: next }));

  const start = (doc) => guard.current.run(doc.id, async () => {
    setState(doc.id, { status: 'downloading', progress: 0 });
    try {
      await downloadDocument(`/documents/${doc.id}/file`, doc.name, { onProgress: (progress) => setState(doc.id, { status: 'downloading', progress }) });
      setState(doc.id, { status: 'idle' });
      if (Platform.OS === 'web') toast(t('docs_downloaded').replace('{name}', doc.name)); // on a phone the share sheet opens
    } catch (err) {
      // Always a message of ours, in the language the app is showing (never the server's English sentence).
      const message = t(downloadErrorInfo(err).key);
      setState(doc.id, { status: 'error', message });
      toast(message);
    }
  });

  const shown = filterDocuments(docs, query);

  return (
    <Screen>
      <TopBar title={t('my_documents')} />
      <Body contentClassName="px-[18px] py-4">
        {loading ? <LoadingState /> : null}

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
          <>
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
              shown.map((d) => <DocumentCard key={d.id} doc={d} state={downloads[d.id]} onPress={() => start(d)} t={t} />)
            )}
          </>
        ) : null}
      </Body>
    </Screen>
  );
}
