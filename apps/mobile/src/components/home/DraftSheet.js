import { useState } from 'react';
import { Animated, Modal, PanResponder, Pressable, View } from 'react-native';
import { PencilLine } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useApp } from '../../state/AppContext';
import { COLORS } from '../../theme/colors';
import { MODAL_EDGE_PROPS } from '../keyboard';
import { Button, Text } from '../ui';
import { shouldDismissSheet, sheetOffset } from '../../lib/sheetDrag';
import { TextButton } from '../network/TextButton';
import { Spinner } from '../Spinner';

// "Saved draft found": the question asked when a new request is started while an unfinished one is saved on the phone. A bottom sheet over a dimmed screen (it replaces the native alert):
// a drag handle, a pencil in a soft circle, the title and the text, then Resume (primary), Start new (outline, red: it deletes the saved draft) and Cancel. The three actions are exactly the old
// alert's: Resume opens the saved draft, Start new discards it and begins a new request, Cancel does nothing. Tapping the dimmed area is Cancel.
const FONT = { 400: 'Inter_400Regular', 800: 'Inter_800ExtraBold' };

// `busy`: null, or 'resume' / 'new' while the choice is being carried out (the saved draft is read, or deleted): the tapped button shows its spinner at once, the sheet stays up, and a second tap does nothing.
export function DraftSheet({ visible, busy = null, onResume, onStartNew, onCancel }) {
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onCancel} {...MODAL_EDGE_PROPS}>
      <View style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(15,23,42,0.45)' }}>
        {/* The dimmed area closes the sheet by touch; a screen reader has the Cancel button, so this is not a second one. */}
        <Pressable accessible={false} importantForAccessibility="no" onPress={onCancel} style={{ flex: 1 }} />
        <DraftSheetBody busy={busy} onResume={onResume} onStartNew={onStartNew} onCancel={onCancel} />
      </View>
    </Modal>
  );
}

// The sheet itself (no Modal): the handle, the pencil, the text and the three buttons.
export function DraftSheetBody({ busy = null, onResume, onStartNew, onCancel }) {
  const { t } = useApp();
  const insets = useSafeAreaInsets();
  // Dragging the sheet down (or flicking it) closes it, the same as Cancel; a short drag springs back (lib/sheetDrag.js).
  const [offset] = useState(() => new Animated.Value(0));
  const [pan] = useState(() => PanResponder.create({
    onMoveShouldSetPanResponder: (_e, g) => g.dy > 6 && Math.abs(g.dy) > Math.abs(g.dx),
    onPanResponderMove: (_e, g) => offset.setValue(sheetOffset(g.dy)),
    onPanResponderRelease: (_e, g) => {
      if (shouldDismissSheet({ dy: g.dy, vy: g.vy })) { onCancel(); Animated.timing(offset, { toValue: 0, duration: 0, useNativeDriver: false }).start(); } else Animated.spring(offset, { toValue: 0, useNativeDriver: false }).start();
    },
    onPanResponderTerminate: () => Animated.spring(offset, { toValue: 0, useNativeDriver: false }).start(),
  }));
  return (
        <Animated.View {...pan.panHandlers} accessibilityViewIsModal style={{ transform: [{ translateY: offset }], alignSelf: 'center', width: '100%', maxWidth: 560, backgroundColor: '#FFFFFF', borderTopLeftRadius: 28, borderTopRightRadius: 28, paddingHorizontal: 20, paddingTop: 12, paddingBottom: Math.max(insets.bottom, 12) + 12 }}>
          <View style={{ alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: '#D1D7E3' }} />
          <View aria-hidden accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ alignSelf: 'center', marginTop: 20, width: 64, height: 64, borderRadius: 32, backgroundColor: COLORS.primarySoft, alignItems: 'center', justifyContent: 'center' }}>
            <PencilLine size={28} color={COLORS.primary} strokeWidth={2} />
          </View>
          <Text accessibilityRole="header" style={{ marginTop: 14, textAlign: 'center', fontFamily: FONT[800], fontSize: 22, lineHeight: 28, color: '#0D2340' }}>{t('draft_prompt_title')}</Text>
          <Text style={{ marginTop: 8, textAlign: 'center', fontFamily: FONT[400], fontSize: 15, lineHeight: 22, color: '#5B6B84' }}>{t('draft_prompt_body')}</Text>
          <View style={{ marginTop: 20, gap: 10 }}>
            <Button title={t('draft_resume')} loading={busy === 'resume'} disabled={busy === 'new'} onPress={onResume} className="min-h-[52px] rounded-2xl" />
            <Pressable
              accessibilityRole="button" accessibilityState={{ disabled: !!busy, busy: busy === 'new' }} disabled={!!busy} onPress={onStartNew}
              style={{ minHeight: 52, borderRadius: 16, borderWidth: 1.5, borderColor: '#F1C7C7', backgroundColor: '#FFFFFF', alignItems: 'center', justifyContent: 'center', opacity: busy === 'resume' ? 0.5 : 1 }}
            >
              {busy === 'new' ? <Spinner size={19} color="#C53030" trackColor="#F1C7C7" /> : <Text className="font-inter-bold" style={{ fontSize: 16, color: '#C53030' }}>{t('draft_start_new')}</Text>}
            </Pressable>
            <TextButton title={t('pd_cancel')} onPress={onCancel} />
          </View>
        </Animated.View>
  );
}
