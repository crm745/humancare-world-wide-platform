import { View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { COLORS } from '../../theme/colors';

// Two-tone service icons from the Home design: a soft filled shape behind a 1.8px outline.
// `fill` is the shape behind, `d` the outline on top (the design's own path data).
const circle = (cx, cy, r) => `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0`;
const PLANE = 'M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z';
const TAKEOFF = 'M6.36 17.4 4 17l-2-4 1.1-.55a2 2 0 0 1 1.8 0l.17.1a2 2 0 0 0 1.8 0L8 12 5 6l.9-.45a2 2 0 0 1 2.09.2l4.02 3a2 2 0 0 0 2.1.2l4.19-2.06a2.41 2.41 0 0 1 1.73-.17L21 7a1.4 1.4 0 0 1 .87 1.99l-.38.76c-.23.46-.6.84-1.07 1.08L7.58 17.2a2 2 0 0 1-1.22.18Z';
const HOUSE = 'M3 10a2 2 0 0 1 .7-1.5l7-6a2 2 0 0 1 2.6 0l7 6a2 2 0 0 1 .7 1.5V20a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z';

const PATHS = {
  privatecharter: { fill: PLANE, d: PLANE },
  ground: {
    fill: 'M4 4h8a2 2 0 0 1 2 2v12H3a1 1 0 0 1-1-1V6a2 2 0 0 1 2-2z',
    d: `M10 10H6M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2M19 18h2a1 1 0 0 0 1-1v-3.28a1 1 0 0 0-.684-.948l-1.923-.641a1 1 0 0 1-.578-.502l-1.539-3.076A1 1 0 0 0 16.382 8H14M8 8v4M9 18h6${circle(17, 18, 2)}${circle(7, 18, 2)}`,
  },
  hospital: {
    fill: 'M8 2h8a2 2 0 0 1 2 2v18H6V4a2 2 0 0 1 2-2z',
    d: 'M12 6v4M14 14h-4M14 18h-4M14 8h-4M18 12h2a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2h2M18 22V4a2 2 0 0 0-2-2H8a2 2 0 0 0-2 2v18',
  },
  homecare: { fill: HOUSE, d: `${HOUSE}M12 11v6M9 14h6` },
  commercialair: { fill: TAKEOFF, d: `M2 22h20${TAKEOFF}` },
  // Mortal Remains: an upright, tapered coffin (narrow at the head, widest at the shoulders, narrowing to the foot) with a cross in the middle.
  mortal: {
    fill: 'M9.5 2h5L19 8.5 15.5 22h-7L5 8.5z',
    d: 'M9.5 2h5L19 8.5 15.5 22h-7L5 8.5zM12 6.5V16M8.5 10h7',
  },
  tele: {
    fill: 'M4 6h10a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z',
    d: 'M4 6h10a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2zM16 10l6-3v10l-6-3',
  },
  // Marine Medical Safety: a ship. Medical Value Travel: a medical bag (care that you travel for).
  marine: {
    fill: 'M19.38 19A11.6 11.6 0 0 0 21 13l-8.188-3.639a2 2 0 0 0-1.624 0L3 13.001a11.6 11.6 0 0 0 2.81 7.76Z',
    d: 'M12 2v2M12 9.189V13M19 12V6a2 2 0 0 0-2-2H7a2 2 0 0 0-2 2v6M19.38 19A11.6 11.6 0 0 0 21 13l-8.188-3.639a2 2 0 0 0-1.624 0L3 13.001a11.6 11.6 0 0 0 2.81 7.76M2 20c.6.5 1.2 1 2.5 1 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1s1.2 1 2.5 1c2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1',
  },
  medvalue: {
    fill: 'M4 6h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z',
    d: 'M12 11v4M14 13h-4M16 6V4a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2M18 6v14M6 6v14M4 6h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z',
  },
  corporate: {
    fill: 'M6 22V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18Z',
    d: 'M6 22V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18ZM6 12H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2M18 9h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-2M10 6h4M10 10h4M10 14h4M10 18h4',
  },
};

// The Home "Our Services" look is the ONE look of a service icon everywhere: navy, a soft navy fill, on a white tile with a thin line. (SERVICE_TONE below only lists the services; it is no longer used to colour them.)
export const SERVICE_LOOK = Object.freeze({ color: '#0D2340', fill: '#0D2340', fillOpacity: 0.12, tile: '#FFFFFF', line: '#E4E9F2' });

// [icon colour, tile tint] for each service (the list of services: see SERVICE_LOOK for how they are drawn).
export const SERVICE_TONE = {
  privatecharter: [COLORS.primary, COLORS.primarySoft],
  ground: ['#C53030', '#FDECEC'],
  hospital: ['#0E7C7B', '#E0F5F4'],
  homecare: ['#B4610D', '#FDF0DA'],
  commercialair: ['#4A3FCB', '#EEF1FE'],
  mortal: ['#5B6B84', '#EEF1F6'],
  tele: ['#17803D', '#E4F7EA'],
  corporate: ['#0D2340', '#E4E9F2'],
  marine: ['#0B6E99', '#E1F3FA'],
  medvalue: ['#8A2BB1', '#F4E9FA'],
};

// Older request records can carry the generic "air" service; it uses the plane.
const ALIAS = { air: 'privatecharter' };
const resolve = (key) => ALIAS[key] || (PATHS[key] ? key : 'hospital');

// Decorative: hidden from screen readers (the service name is always next to it).
export function ServiceIcon({ serviceKey, size = 24, color = SERVICE_LOOK.color, fill, fillOpacity = SERVICE_LOOK.fillOpacity }) {
  const key = resolve(serviceKey);
  const tone = color;
  const { fill: shape, d } = PATHS[key];
  return (
    <View accessible={false} importantForAccessibility="no-hide-descendants">
      <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
        <Path d={shape} fill={fill || tone} fillOpacity={fillOpacity} />
        <Path d={d} stroke={tone} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" fill="none" />
      </Svg>
    </View>
  );
}

// The rounded square the icon sits on: the Home tile (white, a 1px line) with the navy icon. No colour is passed in: every service looks the same wherever it is shown.
export function ServiceIconTile({ serviceKey, size = 44, radius = 14 }) {
  const key = resolve(serviceKey);
  return (
    <View style={{ width: size, height: size, borderRadius: radius, backgroundColor: SERVICE_LOOK.tile, borderWidth: 1, borderColor: SERVICE_LOOK.line, alignItems: 'center', justifyContent: 'center' }}>
      <ServiceIcon serviceKey={key} />
    </View>
  );
}
