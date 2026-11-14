/* eslint-disable react-hooks/purity, react-hooks/refs -- timing rules: the gate reads the clock and notes when loading starts and ends (see lib/skeletonGate.js) */
import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo } from 'react-native';
import { nextChangeAt, skeletonVisible } from '../../lib/skeletonGate';

// True while the phone's "Reduce motion" setting is on (and follows it changing).
export function useReduceMotion() {
  const [reduce, setReduce] = useState(false);
  useEffect(() => {
    AccessibilityInfo.isReduceMotionEnabled().then(setReduce).catch(() => {});
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduce);
    return () => sub.remove();
  }, []);
  return reduce;
}

// Whether to draw the skeleton, for a screen that is `loading` its first data (see lib/skeletonGate.js: only after 150 ms, and at
// least 400 ms once shown). `wasShown` says whether it has been shown, so the content that follows fades in only after a skeleton.
export function useSkeletonGate(loading) {
  const [state, setState] = useState({ startedAt: null, endedAt: null });
  const [, force] = useState(0);
  const wasShown = useRef(false);
  const prev = useRef(false);

  // note when loading starts and when it ends
  useEffect(() => {
    if (loading && !prev.current) setState({ startedAt: Date.now(), endedAt: null });
    else if (!loading && prev.current) setState((s) => (s.startedAt === null ? s : { ...s, endedAt: Date.now() }));
    prev.current = loading;
  }, [loading]);

  const visible = skeletonVisible({ ...state, now: Date.now() });
  if (visible) wasShown.current = true;

  // one timer, for the next moment the answer changes
  useEffect(() => {
    const at = nextChangeAt({ ...state, now: Date.now() });
    if (at === null) return undefined;
    const timer = setTimeout(() => force((n) => n + 1), Math.max(0, at - Date.now()) + 1);
    return () => clearTimeout(timer);
  }, [state, visible]);

  return { visible, wasShown: wasShown.current };
}
