import { Text, View } from 'react-native';
import { Pencil } from 'lucide-react-native';
import { C, Card, FONT, WRAP } from './DetailsParts';
import { ServiceIcon } from '../home/ServiceIcon';
import { PressBox } from '../PressBox';
import { COLORS } from '../../theme/colors';

// The pieces of the New Request review step that Request Details does not have: the service card, and a section heading with an Edit pill.

// "Edit" / "Change": a 32 px pill, fully rounded, primarySoft with primary text and a pencil. The touch area is at least 44 px (hitSlop).
export function EditPill({ label, accessibilityLabel, onPress }) {
  return (
    <PressBox
      accessibilityRole="button" accessibilityLabel={accessibilityLabel || label} onPress={onPress}
      hitSlop={{ top: 6, bottom: 6, left: 8, right: 8 }}
      style={({ pressed }) => ({ height: 32, flexShrink: 0, flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, borderRadius: 16, backgroundColor: COLORS.primarySoft, opacity: pressed ? 0.8 : 1 })}
    >
      <Pencil size={14} color={COLORS.primary} strokeWidth={2.4} />
      <Text style={{ fontFamily: FONT[700], fontSize: 13, lineHeight: 16, color: COLORS.primary }}>{label}</Text>
    </PressBox>
  );
}

// A section: an uppercase label on the left, its Edit pill on the right, the card underneath (`children`).
export function ReviewSection({ title, editLabel, editAccessibilityLabel, onEdit, children }) {
  return (
    <View style={{ gap: 8 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, paddingLeft: 4 }}>
        <Text
          accessibilityRole="header"
          style={[{ flex: 1, minWidth: 0, fontFamily: FONT[800], fontSize: 12, lineHeight: 16, letterSpacing: 0.96, textTransform: 'uppercase', color: C.muted }, WRAP]}
        >
          {title}
        </Text>
        <EditPill label={editLabel} accessibilityLabel={editAccessibilityLabel} onPress={onEdit} />
      </View>
      {children}
    </View>
  );
}

// The service chosen: its icon (the same as Home's "Our Services"), "Selected service", the name (it wraps, never cut off) and a Change pill.
export function ServiceCard({ serviceKey, name, label, changeLabel, changeAccessibilityLabel, onChange }) {
  return (
    <Card big padding={16}>
      {/* The row wraps: on a very narrow screen the Change pill drops under the name instead of squeezing it (a word is never broken mid-way). */}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 14 }}>
        <View style={{ width: 52, height: 52, borderRadius: 16, backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: C.line, alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
          <ServiceIcon serviceKey={serviceKey} size={24} color={C.navy} fill={C.navy} fillOpacity={0.12} />
        </View>
        <View style={{ flex: 1, minWidth: 140 }}>
          <Text style={{ fontFamily: FONT[600], fontSize: 12.5, lineHeight: 16, color: C.muted }}>{label}</Text>
          <Text accessibilityRole="header" style={[{ fontFamily: FONT[800], fontSize: 17, lineHeight: 23, color: C.navy }, WRAP]}>{name}</Text>
        </View>
        <EditPill label={changeLabel} accessibilityLabel={changeAccessibilityLabel} onPress={onChange} />
      </View>
    </Card>
  );
}
