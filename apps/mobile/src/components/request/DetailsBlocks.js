import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Check, ChevronRight, CircleAlert, FileText, Image as ImageIcon } from 'lucide-react-native';
import { needsClamp } from '../../lib/requestDetailsView';
import { AlignedText, C, Card, DashedLine, FONT, Field, Section, WRAP } from './DetailsParts';
import { COLORS } from '../../theme/colors';
import { PressBox } from '../PressBox';

// The blocks that draw a request's Patient, Trip, Medical and Documents cards. Request Details and the New Request review step both use
// them, so the two pages look the same. Every value wraps (nothing is cut off) except a file name, which is one line with an ellipsis.

export function Chip({ children, bg, fg, Icon, iconColor, padV = 5, padH = 10, size = 13, line = 18 }) {
  return (
    <View style={{ alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: padV, paddingHorizontal: padH, borderRadius: 999, backgroundColor: bg }}>
      {Icon ? <Icon size={15} color={iconColor || fg} strokeWidth={2.4} /> : null}
      <Text style={[{ flexShrink: 1, fontFamily: FONT[700], fontSize: size, lineHeight: line, color: fg }, WRAP]}>{children}</Text>
    </View>
  );
}

// Two columns, 14 between the rows and 12 between the columns; a full-width field takes its own row.
export function PatientGrid({ fields }) {
  const rows = [];
  let pair = [];
  const flush = () => { if (pair.length) { rows.push(pair); pair = []; } };
  fields.forEach((f) => {
    if (f.full) { flush(); rows.push([f]); } else { pair.push(f); if (pair.length === 2) flush(); }
  });
  flush();
  return (
    <View style={{ gap: 14 }}>
      {rows.map((row) => (
        <View key={row[0].key} style={{ flexDirection: 'row', gap: 12 }}>
          {row.length === 1 && row[0].full ? <Field label={row[0].label} value={row[0].value} style={{ flex: 1 }} /> : (
            <>
              <Field label={row[0].label} value={row[0].value} style={{ flex: 1 }} />
              {row[1] ? <Field label={row[1].label} value={row[1].value} style={{ flex: 1 }} /> : <View style={{ flex: 1 }} />}
            </>
          )}
        </View>
      ))}
    </View>
  );
}

export function Trip({ trip, t }) {
  const hasRoute = trip.from || trip.to;
  return (
    <Card>
      {hasRoute ? (
        <View>
          {trip.from ? (
            <View style={{ flexDirection: 'row', gap: 12 }}>
              <View style={{ width: 14, alignItems: 'center' }}>
                <View style={{ marginTop: 1, width: 14, height: 14, borderRadius: 7, borderWidth: 3, borderColor: C.blue, backgroundColor: '#FFFFFF' }} />
                {trip.to ? <View style={{ flex: 1, paddingTop: 4, paddingBottom: 2 }}><DashedLine /></View> : null}
              </View>
              <Field label={t('lbl_from')} value={trip.from} style={{ flex: 1, paddingBottom: trip.to ? 14 : 0 }} />
            </View>
          ) : null}
          {trip.to ? (
            <View style={{ flexDirection: 'row', gap: 12 }}>
              <View style={{ width: 14, alignItems: 'center' }}>
                <View style={{ marginTop: 1, width: 14, height: 14, borderRadius: 7, backgroundColor: C.blue }} />
              </View>
              <Field label={t('lbl_to')} value={trip.to} style={{ flex: 1 }} />
            </View>
          ) : null}
        </View>
      ) : null}
      {trip.rows.length ? (
        <View style={hasRoute ? { marginTop: 16, paddingTop: 16, borderTopWidth: 1, borderTopColor: C.divider, gap: 14 } : { gap: 14 }}>
          {trip.rows.map((r) => <Field key={r.key} label={r.label} value={r.value} />)}
        </View>
      ) : null}
    </Card>
  );
}

// A row of the Medical card: 12 above and below, a 1px line between rows.
export function MedicalRow({ first, label, children }) {
  return (
    <View style={{ paddingVertical: 12, borderTopWidth: first ? 0 : 1, borderTopColor: C.divider }}>
      {label ? <AlignedText style={{ fontFamily: FONT[600], fontSize: 12.5, lineHeight: 16, color: C.muted, marginBottom: 2 }}>{label}</AlignedText> : null}
      {children}
    </View>
  );
}

// The condition: line breaks kept, four lines when closed. A copy of the full text, invisible, is measured; the button
// shows only when the full text is taller than four lines.
export function Condition({ text, t }) {
  const [open, setOpen] = useState(false);
  const [fullHeight, setFullHeight] = useState(0);
  const textStyle = [{ fontFamily: FONT[500], fontSize: 14.5, lineHeight: 21, color: C.ink }, WRAP];
  const long = needsClamp(fullHeight, 21);
  return (
    <View>
      <View style={{ position: 'absolute', left: 0, right: 0, opacity: 0 }} pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" onLayout={(e) => setFullHeight(e.nativeEvent.layout.height)}>
        <AlignedText style={textStyle}>{text}</AlignedText>
      </View>
      <AlignedText style={textStyle} numberOfLines={open ? undefined : 4}>{text}</AlignedText>
      {long ? (
        <Pressable
          accessibilityRole="button" accessibilityState={{ expanded: open }} onPress={() => setOpen((v) => !v)}
          style={{ minHeight: 44, justifyContent: 'center', alignSelf: 'flex-start' }}
        >
          <Text style={{ fontFamily: FONT[700], fontSize: 14, color: C.blueText }}>{t(open ? 'rd_show_less' : 'rd_show_more')}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

// `pair`: Care level and Patient mobility side by side in one row, as plain text (the review step); otherwise care level is one chip each.
function medicalRows(medical, t, pair) {
  const rows = [];
  if (medical.urgency) {
    rows.push(['urgency', t('rd_urgent'), <Chip key="u" bg={medical.urgency.bg} fg={medical.urgency.fg} Icon={medical.urgency.alert ? CircleAlert : null}>{medical.urgency.label}</Chip>]);
  }
  if (medical.condition) rows.push(['condition', medical.conditionLabel, <Condition key="c" text={medical.condition} t={t} />]);
  if (pair && (medical.care.length || medical.mobility)) {
    rows.push(['pair', null, (
      <View key="pair" style={{ flexDirection: 'row', gap: 12 }}>
        {medical.care.length ? <Field label={t('field_care_level')} value={medical.care.join(', ')} style={{ flex: 1 }} /> : null}
        {medical.mobility ? <Field label={t('req_mobility')} value={medical.mobility} style={{ flex: 1 }} /> : null}
        {!(medical.care.length && medical.mobility) ? <View style={{ flex: 1 }} /> : null}
      </View>
    )]);
  }
  if (!pair && medical.care.length) {
    rows.push(['care', t('field_care_level'), (
      <View key="care" style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 4 }}>
        {medical.care.map((c) => <Chip key={c} bg={C.soft} fg={C.navy} padV={6} padH={12} size={13.5}>{c}</Chip>)}
      </View>
    )]);
  }
  if (!pair && medical.mobility) {
    rows.push(['mobility', t('req_mobility'), <AlignedText key="m" style={[{ fontFamily: FONT[700], fontSize: 15, lineHeight: 21, color: C.ink }, WRAP]}>{medical.mobility}</AlignedText>]);
  }
  if (medical.equipment) {
    rows.push(['equipment', t('req_on_board'), medical.equipment.none ? (
      <Text key="n" style={{ fontFamily: FONT[700], fontSize: 15, lineHeight: 21, color: C.ink }}>{t('req_none')}</Text>
    ) : (
      <View key="e" style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 4 }}>
        {medical.equipment.items.map((label) => <Chip key={label} bg={C.soft} fg={C.navy} Icon={Check} iconColor={COLORS.primary} padV={6} padH={12} size={13.5}>{label}</Chip>)}
      </View>
    )]);
  }
  return rows;
}

// The Medical card alone (no heading), or nothing when there is nothing to show.
export function MedicalCard({ medical, t, pair }) {
  const rows = medicalRows(medical, t, pair);
  if (!rows.length) return null;
  return (
    <Card padding={0} style={{ paddingVertical: 4, paddingHorizontal: 16 }}>
      {rows.map(([key, label, node], i) => <MedicalRow key={key} first={i === 0} label={label}>{node}</MedicalRow>)}
    </Card>
  );
}

export function Medical({ medical, t }) {
  const card = <MedicalCard medical={medical} t={t} />;
  return medicalRows(medical, t, false).length ? <Section title={t('rd_medical')}>{card}</Section> : null;
}

export function DocumentRow({ doc, first, t, onOpen }) {
  const Icon = doc.isImage ? ImageIcon : FileText;
  const body = (
    <>
      <View style={{ width: 40, height: 40, borderRadius: 12, backgroundColor: doc.isImage ? '#E0F5F4' : COLORS.primarySoft, alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
        <Icon size={20} color={doc.isImage ? '#0B6564' : C.blueText} />
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <AlignedText numberOfLines={1} ellipsizeMode="tail" style={{ fontFamily: FONT[600], fontSize: 14.5, lineHeight: 20, color: C.ink }}>{doc.name}</AlignedText>
        {doc.meta ? <AlignedText style={[{ fontFamily: FONT[400], fontSize: 12.5, lineHeight: 17, color: C.muted }, WRAP]}>{doc.meta}</AlignedText> : null}
        {doc.statusLabel ? <AlignedText style={{ marginTop: 2, fontFamily: FONT[700], fontSize: 12.5, lineHeight: 17, color: doc.status === 'approved' ? '#0B6564' : ['rejected', 'unsafe', 'scan_failed'].includes(doc.status) ? '#C53030' : C.blueText }}>{doc.statusLabel}</AlignedText> : null}
        {doc.reason ? <AlignedText style={[{ marginTop: 2, fontFamily: FONT[400], fontSize: 12.5, lineHeight: 18, color: '#C53030' }, WRAP]}>{doc.reason}</AlignedText> : null}
      </View>
      {doc.openable ? <ChevronRight size={20} color="#8A97AB" /> : null}
    </>
  );
  const box = { minHeight: 66, flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, paddingHorizontal: 16, borderTopWidth: first ? 0 : 1, borderTopColor: C.divider };
  if (!doc.openable) return <View style={box}>{body}</View>;
  return (
    <PressBox accessibilityRole="button" accessibilityLabel={t('rd_open_document', { name: doc.name })} onPress={onOpen} style={({ pressed }) => [box, { opacity: pressed ? 0.8 : 1 }]}>{body}</PressBox>
  );
}
