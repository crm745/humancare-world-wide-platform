import { View } from 'react-native';
import { CircleAlert, CircleCheck, FileText, Image as ImageIcon } from 'lucide-react-native';
import { useApp } from '../../state/AppContext';
import { uploadSummary } from '../../lib/uploadRecovery';
import { Text } from '../ui';
import { COLORS } from '../../theme/colors';

// The list every service shows for the files of a request: one row per file, with a 40 px tile (document or picture), the name on one line, and ONE plain status line:
//   Uploaded             green, with a check
//   Uploading… 62%       brand blue, with a 4 px progress bar under it
//   Not sent yet         a grey dot (also what a file whose answer was lost shows: the one Try again belongs to the screen)
//   <the server's reason> red, with an alert icon (a file the server refused, e.g. "Unsupported file type")
// Nothing else: the one "Try again" button belongs to the screen. (Behind it, lib/uploadRecovery.js still keeps every file's upload id and asks the server what it has BEFORE anything is sent
// again, so a retry never creates a duplicate.) `bare` draws the rows only, for a screen that already has its own card around them.
const FONT = { 400: 'Inter_400Regular', 600: 'Inter_600SemiBold', 700: 'Inter_700Bold', 800: 'Inter_800ExtraBold' };
const IMAGE = /\.(jpe?g|png|gif|webp|heic|heif)$/i;
const isImageFile = (file) => IMAGE.test(String(file.name || file.uri || ''));
const trimStop = (text) => String(text || '').replace(/\.\s*$/, '');

// The words of a file's status (what the row says, and what a screen reader reads after the name).
function statusText({ file, state: s }, state, progress, t) {
  if (s === 'accepted') return t('up_state_accepted');
  if (s === 'sending') return t('up_state_sending').replace('{p}', String(Math.round(Math.max(0, Math.min(1, progress || 0)) * 100)));
  if (s === 'refused') return trimStop(state.errors[file.uri]);
  return t('up_state_pending');
}

function Status({ row, state, progress, t }) {
  const { file, state: s } = row;
  if (s === 'accepted') {
    return (
      <View style={{ marginTop: 2, flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        <CircleCheck size={16} color="#1E7F45" strokeWidth={2.2} />
        <Text style={{ fontFamily: FONT[700], fontSize: 13, lineHeight: 18, color: '#1E7F45' }}>{t('up_state_accepted')}</Text>
      </View>
    );
  }
  if (s === 'sending') {
    const share = Math.max(0, Math.min(1, progress || 0));
    return (
      <View style={{ marginTop: 2 }}>
        <Text style={{ fontFamily: FONT[700], fontSize: 13, lineHeight: 18, color: COLORS.primary }}>{t('up_state_sending').replace('{p}', String(Math.round(share * 100)))}</Text>
        <View style={{ marginTop: 6, height: 4, borderRadius: 2, backgroundColor: '#E4E9F2', overflow: 'hidden' }}>
          <View style={{ height: 4, width: `${Math.max(share, 0.02) * 100}%`, backgroundColor: COLORS.primary }} />
        </View>
      </View>
    );
  }
  if (s === 'refused') {
    return (
      <View style={{ marginTop: 2, flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        <CircleAlert size={16} color="#B42828" strokeWidth={2.2} />
        <Text style={{ flex: 1, fontFamily: FONT[700], fontSize: 13, lineHeight: 18, color: '#B42828' }}>{trimStop(state.errors[file.uri])}</Text>
      </View>
    );
  }
  return (
    <View style={{ marginTop: 2, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
      <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: '#A3AEC2' }} />
      <Text style={{ fontFamily: FONT[600], fontSize: 13, lineHeight: 18, color: '#5B6B84' }}>{t('up_state_pending')}</Text>
    </View>
  );
}

export function UploadStatusList({ files, state, sendingUri = null, progress = 0, bare = false }) {
  const { t } = useApp();
  const summary = uploadSummary(files, state, sendingUri);
  if (!summary.rows.length) return null;
  const rows = summary.rows.map((row, i) => {
    const image = isImageFile(row.file);
    const Icon = image ? ImageIcon : FileText;
    return (
      <View key={row.file.uri} accessible accessibilityLabel={`${row.file.name}, ${statusText(row, state, progress, t)}`} style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, paddingHorizontal: bare ? 0 : 16, borderTopWidth: i === 0 ? 0 : 1, borderTopColor: '#E4E9F2' }}>
        <View style={{ width: 40, height: 40, borderRadius: 12, backgroundColor: image ? '#E0F5F4' : COLORS.primarySoft, alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
          <Icon size={20} color={image ? '#0B6564' : COLORS.primary} strokeWidth={2} />
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text numberOfLines={1} ellipsizeMode="tail" style={{ fontFamily: FONT[600], fontSize: 14.5, lineHeight: 20, color: '#14213D' }}>{row.file.name}</Text>
          <Status row={row} state={state} progress={progress} t={t} />
        </View>
      </View>
    );
  });
  if (bare) return <View>{rows}</View>;
  return (
    <View style={{ width: '100%' }}>
      <Text accessibilityRole="header" style={{ marginBottom: 8, fontFamily: FONT[800], fontSize: 12.5, lineHeight: 17, letterSpacing: 1, textTransform: 'uppercase', color: '#5B6B84' }}>{t('up_docs_count', { n: summary.rows.length })}</Text>
      <View style={{ borderRadius: 20, borderWidth: 1, borderColor: '#E4E9F2', backgroundColor: '#FFFFFF', overflow: 'hidden' }}>{rows}</View>
    </View>
  );
}
