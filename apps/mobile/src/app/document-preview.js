import { useState } from 'react';
import { Image, Pressable, ScrollView, Text, View, useWindowDimensions } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { ChevronLeft, FileQuestion, Share2 } from 'lucide-react-native';
import { useApp } from '../state/AppContext';
import { downloadErrorInfo } from '../lib/download';
import { previewKind } from '../lib/documentPreview';
import { shareDocumentFile, fetchDocumentFile } from '../lib/documentFile';
import { useDocumentFile } from '../lib/useDocumentFile';
import { goBack } from '../lib/nav';
import { Screen } from '../components/layout';
import { Spinner } from '../components/Spinner';
import { PressBox } from '../components/PressBox';
import { PDF_VIEWER_AVAILABLE, PdfViewer } from '../components/documents/PdfViewer';
import { C, FONT, WRAP } from '../components/request/DetailsParts';
import { COLORS } from '../theme/colors';

// The document preview: tapping a document (Request Details, My Documents) opens this. Images (with zoom where the platform supports it) and PDF
// are shown inside the app; anything else says so. Sharing happens ONLY when the person taps the Share button here.
// The file is fetched with the person's sign-in from GET /documents/:id/file (see lib/documentFile.js); the temporary copy goes when this closes.
const first = (value) => (Array.isArray(value) ? value[0] : value);

function Centered({ children }) {
  return <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 28, gap: 12 }}>{children}</View>;
}

function Message({ title, text, children }) {
  return (
    <Centered>
      <View style={{ width: 56, height: 56, borderRadius: 18, backgroundColor: COLORS.primarySoft, alignItems: 'center', justifyContent: 'center' }}>
        <FileQuestion size={26} color={COLORS.primary} />
      </View>
      <Text accessibilityRole="header" style={[{ fontFamily: FONT[800], fontSize: 16, lineHeight: 22, color: C.navy, textAlign: 'center' }, WRAP]}>{title}</Text>
      {text ? <Text style={[{ fontFamily: FONT[400], fontSize: 13.5, lineHeight: 20, color: C.muted, textAlign: 'center' }, WRAP]}>{text}</Text> : null}
      {children}
    </Centered>
  );
}

function ActionButton({ label, onPress, busy }) {
  return (
    <PressBox
      accessibilityRole="button" accessibilityLabel={label} onPress={onPress} disabled={busy}
      style={({ pressed }) => ({ minHeight: 48, minWidth: 160, paddingHorizontal: 22, borderRadius: 14, backgroundColor: COLORS.primary, alignItems: 'center', justifyContent: 'center', opacity: busy ? 0.5 : pressed ? 0.88 : 1 })}
    >
      <Text style={{ fontFamily: FONT[700], fontSize: 15, color: '#FFFFFF' }}>{label}</Text>
    </PressBox>
  );
}

// An image, in a scroll area that zooms on iOS and in the browser. (React Native on Android has no pinch zoom for a plain image.)
function ImagePreview({ uri, onFailed }) {
  const { width, height } = useWindowDimensions();
  return (
    <ScrollView
      style={{ flex: 1 }} contentContainerStyle={{ flexGrow: 1, alignItems: 'center', justifyContent: 'center' }}
      maximumZoomScale={4} minimumZoomScale={1} centerContent bouncesZoom showsVerticalScrollIndicator={false} showsHorizontalScrollIndicator={false}
    >
      <Image source={{ uri }} resizeMode="contain" onError={onFailed} accessibilityRole="image" style={{ width, height: Math.max(240, height - 150) }} />
    </ScrollView>
  );
}

export default function DocumentPreview() {
  const { t, toast } = useApp();
  const params = useLocalSearchParams();
  const id = first(params.id);
  const name = first(params.name) || '';
  const kind = previewKind(name);
  const file = useDocumentFile({ id, name, enabled: kind !== 'unsupported' && Boolean(id) });
  const [broken, setBroken] = useState(false); // the viewer could not draw a file that did download
  const [sharing, setSharing] = useState(false);

  // Share is an explicit tap. For a file that cannot be previewed nothing has been downloaded yet: it is fetched now, then shared.
  const share = async () => {
    if (sharing) return;
    setSharing(true);
    let temporary = null;
    try {
      let target = file.file;
      if (!target) { temporary = await fetchDocumentFile(id, name); target = temporary; }
      await shareDocumentFile({ uri: target.uri, blob: target.blob, name });
    } catch (err) {
      if (!(err && (err.name === 'AbortError' || err.code === 'ERR_SHARING_CANCELLED'))) toast(t(downloadErrorInfo(err).key));
    } finally {
      if (temporary) temporary.dispose();
      setSharing(false);
    }
  };

  let body;
  if (!id) {
    body = <Message title={t('docs_err_missing')} />;
  } else if (kind === 'unsupported') {
    body = <Message title={t('dp_unsupported_title')} text={t('dp_unsupported_text')}><ActionButton label={t('dp_share')} onPress={share} busy={sharing} /></Message>;
  } else if (file.status === 'error') {
    body = (
      <Message title={t(downloadErrorInfo(file.error).key)}>
        <ActionButton label={t('docs_try_again')} onPress={() => { setBroken(false); file.retry(); }} />
      </Message>
    );
  } else if (file.status !== 'ready') {
    const percent = Math.round((file.progress || 0) * 100);
    body = (
      <Centered>
        <View accessible accessibilityRole="progressbar" accessibilityLabel={t('dp_loading')} accessibilityState={{ busy: true }} style={{ alignItems: 'center', gap: 12 }}>
          <Spinner size={30} color={COLORS.primary} trackColor={COLORS.primarySoft} />
          <Text style={{ fontFamily: FONT[600], fontSize: 14, color: C.muted }}>{percent > 0 && percent < 100 ? `${t('dp_loading')} ${percent}%` : t('dp_loading')}</Text>
        </View>
      </Centered>
    );
  } else if (broken) {
    body = <Message title={t(kind === 'image' ? 'dp_image_failed' : 'docs_err_generic')}><ActionButton label={t('docs_try_again')} onPress={() => { setBroken(false); file.retry(); }} /></Message>;
  } else if (kind === 'image') {
    body = <ImagePreview uri={file.file.uri} onFailed={() => setBroken(true)} />;
  } else if (PDF_VIEWER_AVAILABLE) {
    body = <PdfViewer uri={file.file.uri} title={name} onError={() => setBroken(true)} />;
  } else {
    body = <Message title={t('dp_unsupported_title')} text={t('dp_pdf_unavailable')} />;
  }

  // Share is offered once there is something to share (the downloaded file), or at once for a file that cannot be previewed.
  const canShare = Boolean(id) && (kind === 'unsupported' ? false : file.status === 'ready');
  return (
    <Screen style={{ backgroundColor: '#F2F6FC' }}>
      <View style={{ height: 76, flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, backgroundColor: '#FFFFFF', borderBottomWidth: 1, borderBottomColor: C.line }}>
        <Pressable
          accessibilityRole="button" accessibilityLabel={t('home_back')} onPress={goBack}
          style={{ width: 48, height: 48, borderRadius: 14, backgroundColor: C.soft, alignItems: 'center', justifyContent: 'center' }}
        >
          <ChevronLeft size={22} color={C.navy} strokeWidth={2.4} />
        </Pressable>
        <Text accessibilityRole="header" numberOfLines={1} ellipsizeMode="middle" style={{ flex: 1, minWidth: 0, fontFamily: FONT[800], fontSize: 16, lineHeight: 22, color: C.navy }}>{name || t('my_documents')}</Text>
        {canShare ? (
          <PressBox
            accessibilityRole="button" accessibilityLabel={t('dp_share')} onPress={share} disabled={sharing}
            hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
            style={({ pressed }) => ({ height: 40, flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 14, borderRadius: 20, backgroundColor: COLORS.primarySoft, opacity: sharing ? 0.5 : pressed ? 0.8 : 1 })}
          >
            <Share2 size={16} color={COLORS.primary} strokeWidth={2.3} />
            <Text style={{ fontFamily: FONT[700], fontSize: 13.5, color: COLORS.primary }}>{t('dp_share')}</Text>
          </PressBox>
        ) : null}
      </View>
      <View style={{ flex: 1 }}>{body}</View>
    </Screen>
  );
}

