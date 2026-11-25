// The success animation of the Request Submitted screen, as plain numbers (no React, no native modules), so the timeline can be unit-tested. components/request/SubmittedMark.js draws it.
//
// One clock, in milliseconds, from 0 to DURATION_MS. frameAt(ms) says what every layer looks like at that moment:
//   0-900     the arc draws round the ring (strokeDashoffset 277 -> 0), brand blue, cubic-bezier(0.4, 0, 0.2, 1)
//   800-1000  the three dots fade out
//   900-1100  the arc turns from brand blue to teal
//   1000-1300 the pale teal fill grows from the centre: 0 -> 1.06 -> 1 (ease-out)
//   1150-1450 the check mark draws (strokeDashoffset 64 -> 0, ease-out)
// The final frame (ms >= DURATION_MS) is the whole picture: full teal ring, pale teal fill, teal check, no dots. It is also what Reduce Motion shows at once.
// Every function is a worklet so reanimated can run it on the UI thread; in plain JS (tests) the directive does nothing.

import { COLORS as BRAND } from '../theme/colors';

export const DURATION_MS = 1450;
export const SIZE = 108;
export const RING = Object.freeze({ cx: 54, cy: 54, r: 44, stroke: 6, dash: 277 }); // 2 * PI * 44 = 276.46
export const FILL_R = 38;
export const CHECK = Object.freeze({ d: 'M34 55 L48 69 L75 40', dash: 64, stroke: 7 });
export const DOTS = Object.freeze([{ cx: 42, opacity: 1 }, { cx: 54, opacity: 0.7 }, { cx: 66, opacity: 0.4 }]);
export const COLORS = Object.freeze({ track: '#E4E9F2', fill: '#E0F5F4', blue: BRAND.primary, teal: '#0B6564' });

const clamp01 = (x) => { 'worklet'; return x < 0 ? 0 : x > 1 ? 1 : x; };
const easeOut = (x) => { 'worklet'; const k = 1 - clamp01(x); return 1 - k * k * k; };

// cubic-bezier(x1, y1, x2, y2) like CSS: y for a given progress x in [0, 1] (a few Newton steps, then bisection as a safety net).
export function bezier(x1, y1, x2, y2, x) {
  'worklet';
  const cx = 3 * x1; const bx = 3 * (x2 - x1) - cx; const ax = 1 - cx - bx;
  const cy = 3 * y1; const by = 3 * (y2 - y1) - cy; const ay = 1 - cy - by;
  const sampleX = (s) => ((ax * s + bx) * s + cx) * s;
  const sampleY = (s) => ((ay * s + by) * s + cy) * s;
  const slopeX = (s) => (3 * ax * s + 2 * bx) * s + cx;
  const target = clamp01(x);
  let s = target;
  for (let i = 0; i < 6; i += 1) {
    const err = sampleX(s) - target;
    if (Math.abs(err) < 1e-6) return sampleY(s);
    const d = slopeX(s);
    if (Math.abs(d) < 1e-6) break;
    s -= err / d;
  }
  let lo = 0; let hi = 1; s = target;
  for (let i = 0; i < 24; i += 1) {
    const v = sampleX(s);
    if (Math.abs(v - target) < 1e-6) break;
    if (v < target) lo = s; else hi = s;
    s = (lo + hi) / 2;
  }
  return sampleY(s);
}

const hex = (c) => { 'worklet'; return [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)]; };
function mix(a, b, m) {
  'worklet';
  const x = hex(a); const y = hex(b);
  return `rgb(${Math.round(x[0] + (y[0] - x[0]) * m)}, ${Math.round(x[1] + (y[1] - x[1]) * m)}, ${Math.round(x[2] + (y[2] - x[2]) * m)})`;
}

export function frameAt(ms) {
  'worklet';
  const arcT = bezier(0.4, 0, 0.2, 1, ms / 900);
  const fillT = clamp01((ms - 1000) / 300);
  const fillScale = fillT <= 0 ? 0 : fillT < 0.7 ? 1.06 * easeOut(fillT / 0.7) : 1.06 - 0.06 * easeOut((fillT - 0.7) / 0.3);
  const checkT = easeOut((ms - 1150) / 300);
  return {
    arcOffset: RING.dash * (1 - arcT),
    arcColor: mix(COLORS.blue, COLORS.teal, clamp01((ms - 900) / 200)),
    arcTeal: clamp01((ms - 900) / 200), // the same turn to teal, as the opacity of a teal ring laid over the blue one (a colour string is not reliably applied to an SVG stroke on the web)
    dotsOpacity: 1 - clamp01((ms - 800) / 200),
    fillRadius: FILL_R * fillScale,
    checkOffset: CHECK.dash * (1 - checkT),
    checkVisible: ms >= 1150 ? 1 : 0, // a round cap would show as a dot before the check starts to draw
  };
}

export const FINAL_FRAME = frameAt(DURATION_MS);
