import { useEffect, useRef, useState } from 'react';
import { Pressable, View } from 'react-native';
import { router } from 'expo-router';
import { Search } from 'lucide-react-native';
import { useApp } from '../state/AppContext';
import { useNetwork } from '../state/NetworkContext';
import { apiGet } from '../lib/api';
import { openDocumentPreview } from '../lib/documentPreview';
import { openSavedDownload, saveDocumentToDevice } from '../lib/documentSave';
import { isSaveCancelled } from '../lib/documentSaveRules';
import { downloadErrorInfo } from '../lib/download';
import { filterDocuments } from '../lib/documentsView';
import { TRACKING_PALETTE as P } from '../lib/tracking/palette';
import { Body, Screen, TopBar } from '../components/layout';
import { Input, Text } from '../components/ui';
import { AppRefreshControl } from '../components/AppRefreshControl';
import { Reveal } from '../components/skeleton/Reveal';
import { useSkeletonGate } from '../components/skeleton/hooks';
import { RowsSkeleton } from '../components/skeleton/screens';
import { useResource } from '../lib/useResource';
import { DocumentCard } from '../components/documents/DocumentCard';
import { DownloadDone } from '../components/documents/DownloadDone';
import { LoadFailure } from '../components/LoadFailure';
import { CachedNote } from '../components/network/CachedNote';

// My Documents: every document attached to the patient's cases, from GET /requests/me/documents (unchanged). Each card
// shows the file name, its type and size, the case reference and when it was added to the case; tapping it opens the in-app preview
// (app/document-preview.js), which loads it with progress, shows an error with Try again if it cannot, and has its own Share button.
export default function MyDocuments() {
  const { t, toast } = useApp();
  const { isOffline } = useNetwork();
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
  // Offline, nothing is opened: the preview would only start a download that cannot finish (no document is ever kept on the phone to show instead).
  const start = (doc) => { if (isOffline) return; openDocumentPreview(router.push, doc); };

  // The download button on a card SAVES the document (lib/documentSave.js): the person picks a folder (Downloads on Android, the Files app on iOS), the file is fetched with their sign-in (progress on the card)
  // and written there under its own name and extension; the browser saves it on the web. It never opens the share sheet. One download at a time (a second tap does nothing); success is a short message, a
  // failure says why on the card and tapping the button again tries again; closing the folder picker is not a failure.
  const [downloads, setDownloads] = useState({}); // document id -> { status: 'downloading' | 'error', progress, message }
  const [done, setDone] = useState(null); // the in-app "Download complete" message: { name, onOpen }
  useEffect(() => {
    if (!done) return undefined;
    const timer = setTimeout(() => setDone(null), 10000);
    return () => clearTimeout(timer);
  }, [done]);
  const downloading = useRef(false);
  const setState = (id, state) => setDownloads((all) => ({ ...all, [id]: state }));
  // OPEN: a file in the public Downloads folder opens in whichever installed app can show it; a copy kept inside the app opens in the app's own preview (it is the saved file, not downloaded again).
  const openSaved = async (doc, saved) => {
    setDone(null);
    if (saved.location === 'downloads') {
      if (!(await openSavedDownload(saved))) toast(t('docs_no_viewer'));
      return;
    }
    router.push({ pathname: '/document-preview', params: { id: String(doc.id), name: saved.name, localUri: saved.uri } });
  };
  const download = async (doc) => {
    if (downloading.current) return;
    if (isOffline) return; // the button is not drawn offline
    downloading.current = true;
    setState(doc.id, { status: 'downloading', progress: 0 });
    try {
      const saved = await saveDocumentToDevice(doc.id, doc.name, (progress) => setState(doc.id, { status: 'downloading', progress }), t);
      setState(doc.id, { status: 'idle' });
      if (saved.location === 'browser') toast(t('docs_saved').replace('{name}', saved.name)); // the browser shows its own download
      else if (!saved.notified) setDone({ name: saved.name, onOpen: () => openSaved(doc, saved) }); // no notification was shown (iOS, notifications refused, or a copy kept inside the app)
    } catch (err) {
      if (isSaveCancelled(err)) setState(doc.id, { status: 'idle' });
      else setState(doc.id, { status: 'error', message: t(downloadErrorInfo(err).key) });
    } finally {
      downloading.current = false;
    }
  };

  const shown = filterDocuments(docs, query);

  return (
    <Screen>
      <TopBar title={t('prof_documents')} />
      <Body contentClassName="px-[18px] py-4" noScrollWhenFits={!loading && !!failed} refreshControl={<AppRefreshControl refreshing={refreshing} onRefresh={onRefresh} />}>
        {loading && gate.visible ? <RowsSkeleton label={t('sk_loading_documents')} count={5} lines={2} trailing /> : null}

        {!loading && failed ? <LoadFailure titleKey="lf_title_documents" error={error} message={t('docs_load_failed')} onRetry={retry} /> : null}

        {!loading && !failed && docs.length === 0 ? (
          <View className="items-center px-5 py-[50px]">
            <Text className="text-center font-inter-bold text-[14px] text-navy">{t('docs_empty_title')}</Text>
            <Text className="mt-1.5 text-center text-[12.5px] text-faint">{t('docs_empty_sub')}</Text>
          </View>
        ) : null}

        {!loading && !failed && docs.length > 0 ? (
          <Reveal animate={gate.wasShown}>
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
              shown.map((d) => <DocumentCard key={d.id} doc={d} state={downloads[d.id]} onPress={() => start(d)} onDownload={() => download(d)} t={t} isNew={highlight.includes(d.id)} offline={isOffline} />)
            )}
            <CachedNote />
          </Reveal>
        ) : null}
      </Body>
      <DownloadDone done={done} onDismiss={() => setDone(null)} />
    </Screen>
  );
}
