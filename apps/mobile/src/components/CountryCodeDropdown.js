import { useCallback, useEffect, useRef, useState } from 'react';
import { Keyboard, Pressable, ScrollView, View, useWindowDimensions } from 'react-native';
import { Check, ChevronDown } from 'lucide-react-native';
import { COUNTRY_CODES, CALLING_CODE_COUNTRY } from '../data/mock';
import { MAX_SETTLE_FRAMES, codeRows, listPlacement, rowText, sameSpot } from '../lib/countryCodeDropdown';
import { Text } from './ui';
import { PressBox } from './PressBox';
import { useKeyboard } from './keyboard';
import { COLORS } from '../theme/colors';

// The login screen's country-code field, like a plain select: a small button that shows the country code and dial code ("IN +91"). It sits in the row with the number field (`children`), and the
// value is still the dial code ("+91"). No modal, no search, no country names.
//
// The list of codes ("US +1", "GB +44") is a FLOATING overlay (`CountryCodeOverlay`), not part of the form: it takes no room, so opening or closing it never moves the fields under it (Password, Forgot
// password, Login). The screen draws it inside its scrolling page (the content of its `Body`), where it can be touched and scrolled on Android, iOS and the web (a list that floats outside its parent's
// bounds cannot be on Android). It is placed under the button, or over it when there is no room under it (lib/countryCodeDropdown.js listPlacement), inside the visible screen, as tall as that
// room allows up to CODE_LIST_MAX, and it scrolls inside itself.
//
// Closing: a pick, a tap on the button again (the button is the one thing that does not announce its touch to the page), or a touch anywhere else on the page. That last one is the screen's `Body`
// `onTouchStart`: it only HEARS the touch and does not take it, so a tap on the Password field (or any other control) both closes the list and goes to that field as normal (it gets the focus).
// There is no full-page layer in front of the form. The app has ONE back-button handler, at the root, so the list adds none of its own.
export const CODE_LIST_MAX = 360;
const EDGE_GAP = 12; // kept free between the list and the bottom of the screen / the keyboard
const TOP_GAP = 48; // and under the top of the screen
const GAP = 2; // between the button and the list

const ROWS = codeRows(COUNTRY_CODES, CALLING_CODE_COUNTRY);
const keepTouch = (e) => { if (e && e.stopPropagation) e.stopPropagation(); }; // this touch is not "outside": the page's onTouchStart does not hear it

// The button. `anchorRef` is set to the row (the button and the number field), which is what the list is placed against.
export function CountryCodeField({ value, onChange, open, onOpenChange, title, children, large = true, buttonWidth = 128, anchorRef }) {
  const selected = ROWS.find((r) => r.code === value);
  return (
    <View ref={anchorRef} collapsable={false} style={{ flexDirection: 'row', gap: 8 }}>
      <Pressable
        onTouchStart={keepTouch} onPress={() => { if (!open) Keyboard.dismiss(); onOpenChange(!open); }} accessibilityRole="button" accessibilityLabel={`${title}, ${selected ? rowText(selected) : value}`} accessibilityState={{ expanded: open }}
        style={{ width: buttonWidth }}
        className={`flex-row items-center justify-between gap-1 rounded-[10px] border-[1.5px] bg-input ${open ? 'border-primary' : 'border-field'} ${large ? 'px-3 py-3.5' : 'px-3 py-3'}`}
      >
        <Text style={{ fontSize: 16 }} numberOfLines={1}>{selected ? rowText(selected) : value}</Text>
        <View style={open ? { transform: [{ rotate: '180deg' }] } : null}><ChevronDown size={16} color="#97A4B8" /></View>
      </Pressable>
      {children}
    </View>
  );
}

// Where the list goes: the button row and the overlay's own host (a point at the top-left of the page content) are measured in the window, so the list is placed in the page's own coordinates and
// moves with the page when it scrolls. The room under and over comes from the window, less the keyboard (the app's one shared keyboard store, components/keyboard).
//
// A measurement is only trusted when the layout is still: while the keyboard is open, or closing, the page is shifted (it scrolls the focused field into view), so a measurement then is stale the moment
// the keyboard is gone. So: nothing is measured while the store says the keyboard is open (the list is not drawn); once it is closed the row is measured frame by frame (no timer) until two measurements in
// a row agree, and only then is the list drawn. When the keyboard was already closed when the list opened, the first measurement is used at once (nothing is moving) and is still checked in the next frames.
function useOverlaySpot(anchorRef) {
  const hostRef = useRef(null);
  const { height: windowHeight } = useWindowDimensions();
  const { open: keyboardOpen, height: keyboard } = useKeyboard();
  const startedClosed = useRef(!keyboardOpen);
  const [spot, setSpot] = useState(null); // { x, y, h, winY }: the row's left, top and height relative to the host, and its top in the window
  const measure = useCallback((done) => {
    const row = anchorRef && anchorRef.current;
    const host = hostRef.current;
    if (!row || !host || !row.measureInWindow || !host.measureInWindow) { done(null); return; }
    host.measureInWindow((hx, hy) => {
      row.measureInWindow((rx, ry, rw, rh) => {
        done([hx, hy, rx, ry, rh].every(Number.isFinite) ? { x: rx - hx, y: ry - hy, h: rh, winY: ry } : null);
      });
    });
  }, [anchorRef]);
  useEffect(() => {
    if (keyboardOpen) return undefined; // the layout under an open keyboard is not the layout after it: nothing is measured (and the earlier spot was dropped when the keyboard opened)
    let stopped = false;
    let frame = 0;
    let last = null;
    let raf = null;
    const sample = () => {
      measure((m) => {
        if (stopped || !m) return;
        const stable = sameSpot(last, m); // two measurements in a row agree: the layout has stopped moving
        if (frame === 0 ? startedClosed.current : stable) setSpot((prev) => (sameSpot(prev, m) ? prev : m));
        last = m;
        frame += 1;
        if (stable) return;
        if (frame >= MAX_SETTLE_FRAMES) { setSpot((prev) => (sameSpot(prev, m) ? prev : m)); return; } // the bound: use the latest
        raf = requestAnimationFrame(sample);
      });
    };
    sample();
    return () => { stopped = true; if (raf !== null) cancelAnimationFrame(raf); setSpot(null); }; // a spot never outlives the layout it was measured in
  }, [measure, windowHeight, keyboardOpen]);
  const placement = spot
    ? listPlacement({ below: windowHeight - keyboard - (spot.winY + spot.h) - EDGE_GAP, above: spot.winY - TOP_GAP, max: CODE_LIST_MAX })
    : null;
  return { hostRef, spot, placement };
}

// The floating list. Rendered by the screen inside its page content while the list is open; it is absolutely placed, so it adds nothing to the layout.
export function CountryCodeOverlay({ anchorRef, value, onChange, onClose, buttonWidth = 128 }) {
  const { hostRef, spot, placement } = useOverlaySpot(anchorRef);
  const pick = (code) => { onChange(code); onClose(); };
  const height = placement ? placement.maxHeight : 0;
  return (
    <>
      <View ref={hostRef} collapsable={false} pointerEvents="none" style={{ position: 'absolute', top: 0, left: 0, width: 0, height: 0 }} />
      {spot && placement ? (
        <View
          onTouchStart={keepTouch}
          style={{
            position: 'absolute', zIndex: 20, left: spot.x, width: buttonWidth, height,
            top: placement.up ? spot.y - GAP - height : spot.y + spot.h + GAP,
            backgroundColor: '#FFFFFF', borderRadius: 10, borderWidth: 1.5, borderColor: COLORS.primary, overflow: 'hidden',
            shadowColor: '#0D2340', shadowOpacity: 0.16, shadowRadius: 14, shadowOffset: { width: 0, height: 6 }, elevation: 10,
          }}
        >
          <ScrollView style={{ flex: 1 }} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator nestedScrollEnabled>
            {ROWS.map((r, i) => {
              const on = r.code === value;
              return (
                <PressBox
                  key={r.code} onPress={() => pick(r.code)} accessibilityRole="button" accessibilityState={{ selected: on }} accessibilityLabel={rowText(r)}
                  style={({ pressed }) => ({ minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, paddingHorizontal: 12, borderTopWidth: i === 0 ? 0 : 1, borderTopColor: '#EEF1F6', backgroundColor: on ? COLORS.primarySoft : pressed ? '#F2F6FC' : '#FFFFFF' })}
                >
                  <Text style={{ fontSize: 16, color: '#0D2340' }} numberOfLines={1}>{rowText(r)}</Text>
                  {on ? <Check size={16} color={COLORS.primary} strokeWidth={2.6} /> : null}
                </PressBox>
              );
            })}
          </ScrollView>
        </View>
      ) : null}
    </>
  );
}
