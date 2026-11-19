import { View, useWindowDimensions } from 'react-native';
import { cardSpec, scaleFor } from '../../lib/myRequestsLayout';
import { COLORS } from '../../theme/colors';
import { Skeleton, SkeletonArea, SkeletonCircle, SkeletonText } from './Skeleton';

// One skeleton for each data screen, built from the screen's real layout: the same cards, sizes and spacing (the cards and the page are
// the screen's own; only what is inside a card is a block), so nothing jumps when the data arrives. The header, the tab bar and the SOS
// button are not part of any skeleton: they are on screen at once.
const CARD = { backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#E4E9F2' };

// ---- My Requests: request cards (icon tile, two text lines, badge, route, progress) --------------------------------------------
export function RequestCardSkeleton() {
  const { width } = useWindowDimensions();
  const L = cardSpec(scaleFor(width));
  return (
    <View style={{ ...CARD, borderColor: '#E9EEF6', borderRadius: L.radius, paddingTop: L.padTop, paddingHorizontal: L.padSide, paddingBottom: L.padBottom, gap: L.gap }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: L.gap }}>
        <SkeletonCircle size={L.tile} radius={L.tileRadius} />
        <View style={{ flex: 1, minWidth: 0, gap: 6 }}>
          <Skeleton width="72%" height={L.nameLine} />
          <Skeleton width="52%" height={L.subLine} />
        </View>
        <Skeleton width={84} height={L.badgeLine + 2 * L.badgePadY} radius={999} />
      </View>
      <Skeleton width="46%" height={L.routeLine} />
      <View style={{ borderTopWidth: 1, borderTopColor: '#EEF1F6', paddingTop: L.progressPad, gap: L.progressGap }}>
        <View style={{ flexDirection: 'row', gap: L.segGap }}>
          {Array.from({ length: 5 }, (_, i) => <Skeleton key={i} height={L.segHeight} radius={L.segRadius} style={{ flex: 1 }} />)}
        </View>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
          <Skeleton width="40%" height={L.stepLine} />
          <Skeleton width="22%" height={L.stepLine} />
        </View>
      </View>
    </View>
  );
}

export function RequestsSkeleton({ label, count = 4, footer = false }) {
  const { width } = useWindowDimensions();
  const L = cardSpec(scaleFor(width));
  return (
    <SkeletonArea label={label} style={{ gap: L.listGap }}>
      <View style={{ gap: L.listGap }}>
        {Array.from({ length: footer ? 2 : count }, (_, i) => <RequestCardSkeleton key={i} />)}
      </View>
    </SkeletonArea>
  );
}

// ---- Request Details -------------------------------------------------------------------------------------------------------------
const bigCard = { ...CARD, borderRadius: 20, padding: 18 };
const card = { ...CARD, borderRadius: 18, padding: 16 };

function FieldBlock({ valueWidth = '70%' }) {
  return (
    <View style={{ gap: 2 }}>
      <Skeleton width="40%" height={16} />
      <Skeleton width={valueWidth} height={21} />
    </View>
  );
}

export function RequestDetailsSkeleton({ label }) {
  return (
    <SkeletonArea label={label}>
      <View style={{ paddingTop: 16, paddingHorizontal: 16, gap: 14 }}>
        <View style={bigCard}>
          <View style={{ flexDirection: 'row', gap: 14 }}>
            <SkeletonCircle size={52} radius={16} />
            <View style={{ flex: 1, gap: 6 }}>
              <Skeleton width="30%" height={18} />
              <Skeleton width="85%" height={25} />
            </View>
          </View>
          <View style={{ marginTop: 12, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <Skeleton width={96} height={24} radius={999} />
            <Skeleton width={150} height={18} />
          </View>
          <View style={{ marginTop: 16, flexDirection: 'row', gap: 8 }}>
            {[0, 1, 2].map((i) => <Skeleton key={i} height={66} radius={14} style={{ flex: 1 }} />)}
          </View>
        </View>
        <View style={bigCard}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
            <Skeleton width="34%" height={22} />
            <Skeleton width={104} height={28} radius={999} />
          </View>
          <View style={{ marginTop: 12, flexDirection: 'row', gap: 4 }}>
            {Array.from({ length: 5 }, (_, i) => <Skeleton key={i} height={6} radius={3} style={{ flex: 1 }} />)}
          </View>
          <View style={{ marginTop: 10, flexDirection: 'row', justifyContent: 'space-between' }}>
            <Skeleton width="42%" height={19} />
            <Skeleton width="30%" height={17} />
          </View>
        </View>
        <View style={{ gap: 8 }}>
          <Skeleton width={70} height={16} style={{ marginLeft: 4 }} />
          <View style={{ ...card, gap: 14 }}>
            <FieldBlock valueWidth="55%" />
            <View style={{ flexDirection: 'row', gap: 12 }}><View style={{ flex: 1 }}><FieldBlock valueWidth="30%" /></View><View style={{ flex: 1 }}><FieldBlock valueWidth="50%" /></View></View>
            <View style={{ flexDirection: 'row', gap: 12 }}><View style={{ flex: 1 }}><FieldBlock valueWidth="50%" /></View><View style={{ flex: 1 }}><FieldBlock valueWidth="80%" /></View></View>
          </View>
        </View>
        <View style={{ gap: 8 }}>
          <Skeleton width={56} height={16} style={{ marginLeft: 4 }} />
          <View style={{ ...card, gap: 14 }}>
            <FieldBlock valueWidth="85%" />
            <FieldBlock valueWidth="70%" />
          </View>
        </View>
      </View>
    </SkeletonArea>
  );
}

// ---- Tracking Details: the route card (brand blue, as it is) and the timeline ------------------------------------------------------
function TimelineRowSkeleton({ last }) {
  return (
    <View style={{ flexDirection: 'row', gap: 14 }}>
      <View style={{ width: 26, alignItems: 'center' }}>
        <SkeletonCircle size={26} />
        {!last ? <View style={{ position: 'absolute', top: 28, bottom: -2, width: 2, backgroundColor: '#E4E9F2' }} /> : null}
      </View>
      <View style={{ flex: 1, minWidth: 0, paddingTop: 1, paddingBottom: 16, gap: 6 }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 10 }}>
          <Skeleton width="48%" height={20} />
          <Skeleton width="26%" height={17} />
        </View>
        <Skeleton width="66%" height={19} />
      </View>
    </View>
  );
}

export function TrackingSkeleton({ label, rows = 4 }) {
  return (
    <SkeletonArea label={label}>
      <View style={{ paddingTop: 16, paddingHorizontal: 16, gap: 14 }}>
        <View style={{ backgroundColor: COLORS.primary, borderRadius: 20, padding: 18, gap: 16 }}>
          <View style={{ gap: 6 }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
              <Skeleton width={90} height={17} />
              <Skeleton width={100} height={24} radius={999} />
            </View>
            <Skeleton width="78%" height={22} />
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
            <View style={{ gap: 4, width: 90 }}><Skeleton height={24} /><Skeleton width="60%" height={16} /></View>
            <SkeletonCircle size={32} />
            <View style={{ gap: 4, width: 90, alignItems: 'flex-end' }}><Skeleton height={24} width="100%" /><Skeleton width="60%" height={16} /></View>
          </View>
          <View style={{ paddingTop: 14, borderTopWidth: 1, borderTopColor: 'rgba(255,255,255,0.18)', gap: 8 }}>
            <View style={{ flexDirection: 'row', gap: 4 }}>
              {Array.from({ length: rows }, (_, i) => <Skeleton key={i} height={6} radius={3} style={{ flex: 1 }} />)}
            </View>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}><Skeleton width="44%" height={21} /><Skeleton width="22%" height={17} /></View>
            <Skeleton width="38%" height={17} />
          </View>
        </View>
        <View style={{ gap: 8 }}>
          <Skeleton width={78} height={16} style={{ marginLeft: 4 }} />
          <View style={{ ...card, paddingTop: 18, paddingBottom: 4 }}>
            {Array.from({ length: rows }, (_, i) => <TimelineRowSkeleton key={i} last={i === rows - 1} />)}
          </View>
        </View>
      </View>
    </SkeletonArea>
  );
}

// ---- Rows in a card: documents, alerts, cases and the like -----------------------------------------------------------------------
export function RowCardSkeleton({ tile = 40, tileRadius = 11, lines = 2, trailing = false }) {
  return (
    <View style={{ ...CARD, borderRadius: 16, padding: 12, flexDirection: 'row', alignItems: 'center', gap: 12 }}>
      <SkeletonCircle size={tile} radius={tileRadius} />
      <View style={{ flex: 1, minWidth: 0, gap: 6 }}>
        <Skeleton width="70%" height={17} />
        {lines > 1 ? <Skeleton width="48%" height={15} /> : null}
        {lines > 2 ? <Skeleton width="34%" height={15} /> : null}
      </View>
      {trailing ? <Skeleton width={36} height={36} radius={10} /> : null}
    </View>
  );
}

export function RowsSkeleton({ label, count = 5, lines = 2, trailing = false, tile, tileRadius, style }) {
  return (
    <SkeletonArea label={label} style={style}>
      <View style={{ gap: 10 }}>
        {Array.from({ length: count }, (_, i) => <RowCardSkeleton key={i} lines={lines} trailing={trailing} tile={tile} tileRadius={tileRadius} />)}
      </View>
    </SkeletonArea>
  );
}

// ---- Home: the active-request card ------------------------------------------------------------------------------------------------
export function ActiveRequestSkeleton({ label }) {
  return (
    <SkeletonArea label={label} style={{ marginBottom: 18 }}>
      <View style={{ ...CARD, borderRadius: 18, padding: 14, gap: 12 }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
          <Skeleton width={120} height={16} />
          <Skeleton width={78} height={24} radius={999} />
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <SkeletonCircle size={44} radius={13} />
          <View style={{ flex: 1, gap: 6 }}><Skeleton width="70%" height={18} /><Skeleton width="38%" height={15} /></View>
        </View>
        <Skeleton height={18} />
        <View style={{ flexDirection: 'row', gap: 4 }}>{Array.from({ length: 3 }, (_, i) => <Skeleton key={i} height={5} radius={3} style={{ flex: 1 }} />)}</View>
        <Skeleton width="30%" height={16} />
        <Skeleton height={44} radius={12} />
      </View>
    </SkeletonArea>
  );
}

// ---- A page of text lines in cards (the separate Tracking tabs, Personal Details) ---------------------------------------------------
export function FormSkeleton({ label, fields = 5 }) {
  return (
    <SkeletonArea label={label}>
      <View style={{ ...CARD, borderRadius: 18, padding: 16, gap: 16 }}>
        {Array.from({ length: fields }, (_, i) => (
          <View key={i} style={{ gap: 6 }}>
            <Skeleton width="30%" height={14} />
            <Skeleton height={44} radius={10} />
          </View>
        ))}
        <SkeletonText lines={2} lineHeight={14} />
      </View>
    </SkeletonArea>
  );
}
