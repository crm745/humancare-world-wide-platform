import { useEffect, useRef } from 'react';
import { AccessibilityInfo, Pressable, View } from 'react-native';
import { Download, File, FileImage, FileText, FileType } from 'lucide-react-native';
import { fileMeta, fileTypeOf, documentDate, documentAccessibilityLabel, downloadAnnouncement } from '../../lib/documentsView';
import { TRACKING_PALETTE as P } from '../../lib/tracking/palette';
import { Spinner } from '../Spinner';
import { HighlightFill } from '../skeleton/HighlightFill';
import { Text } from '../ui';

// One document on My Documents. A dedicated card (the shared DocRow, which the corporate tracking page also uses, is
// left as it is). The icon follows the file's extension, which is only a display hint.
const ICON = {
  pdf: { Icon: FileText, color: '#D64545', bg: '#FDECEC' },
  image: { Icon: FileImage, color: P.brand, bg: P.brandSoft },
  word: { Icon: FileType, color: P.brand, bg: P.brandSoft },
  other: { Icon: File, color: P.muted, bg: '#EEF3FB' },
};

// Hidden from a screen reader: everything the card shows is already in its one label (documentAccessibilityLabel).
const HIDDEN_FROM_READER = { accessibilityElementsHidden: true, importantForAccessibility: 'no-hide-descendants' };

// state: { status: 'idle' | 'downloading' | 'error', progress (0..1), message }
// `isNew`: a document that was not in the list before the last pull-to-refresh (a brief highlight, 1.8 s).
export function DocumentCard({ doc, state = { status: 'idle' }, onPress, t, isNew = false }) {
  // A change of the download's state (started, failed, finished) is announced once; progress ticks are not.
  const previous = useRef(state);
  useEffect(() => {
    const text = downloadAnnouncement(previous.current, state, doc, t);
    previous.current = state;
    if (text) AccessibilityInfo.announceForAccessibility(text);
  }, [state, doc, t]);

  const { Icon, color, bg } = ICON[fileTypeOf(doc.name).kind];
  const downloading = state.status === 'downloading';
  const added = documentDate(doc.uploadedAt);
  const meta = [fileMeta(doc), doc.case && doc.case.referenceNumber].filter(Boolean).join(' · ');
  const percent = Math.round((state.progress || 0) * 100);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={documentAccessibilityLabel(doc, state, t)}
      accessibilityState={{ busy: downloading, disabled: downloading }}
      disabled={downloading}
      onPress={onPress}
      className="mb-2.5 overflow-hidden rounded-2xl border border-line bg-white active:opacity-80"
    >
      {isNew ? <HighlightFill radius={16} /> : null}
      <View className="flex-row items-center gap-3 p-3" {...HIDDEN_FROM_READER}>
        <View className="h-10 w-10 items-center justify-center rounded-[11px]" style={{ backgroundColor: bg }}>
          <Icon size={19} color={color} />
        </View>
        <View className="flex-1">
          <Text numberOfLines={2} className="font-inter-bold text-[14px] text-navy">{doc.name}</Text>
          {meta ? <Text className="mt-0.5 text-[12px] text-muted">{meta}</Text> : null}
          {added ? <Text className="mt-0.5 text-[12px] text-faint">{added}</Text> : null}
        </View>
        <View className="h-11 w-11 items-center justify-center">
          {downloading ? (
            <View className="items-center gap-0.5">
              <Spinner size={18} color={P.brand} trackColor={P.brandSoft} />
              {state.progress > 0 ? <Text className="text-[10px] text-faint">{`${percent}%`}</Text> : null}
            </View>
          ) : (
            <Download size={18} color={P.brand} />
          )}
        </View>
      </View>
      {downloading ? (
        <View style={{ height: 3, backgroundColor: P.line }} {...HIDDEN_FROM_READER}>
          <View style={{ height: 3, width: `${Math.max(state.progress || 0, 0.04) * 100}%`, backgroundColor: P.brand }} />
        </View>
      ) : null}
      {state.status === 'error' ? (
        <View className="border-t border-divider px-3 py-2" {...HIDDEN_FROM_READER}>
          <Text className="text-[12px] leading-[17px]" style={{ color: P.cancelled }}>{state.message}</Text>
          <Text className="mt-0.5 font-inter-bold text-[12px]" style={{ color: P.brand }}>{t('docs_tap_retry')}</Text>
        </View>
      ) : null}
    </Pressable>
  );
}
