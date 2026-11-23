import { useEffect, useMemo } from 'react';
import { useApp } from '../state/AppContext';
import { createIdleSession, isIdleHeld } from '../lib/idleSession';
import { subscribeAppActive, subscribeWebActivity } from '../lib/idleSessionDevice';
import { submissionTracker } from '../lib/pendingSubmissionStore';
import { signOutSession } from '../lib/signOut';
import { useKeyboardOpen } from './keyboard';

// The 30-minute idle session timeout (rules and numbers: lib/idleSession.js). Used once, by the root layout: it watches touches and typing while someone is signed in, and when 30 minutes pass without
// either (the time in the background counts) it ends the session like Log out does, says why, and the app returns to the login screen. It waits for an upload, a download or a submission that is
// still running. The saved draft is kept (it is encrypted and belongs to the account); the next sign-in finds it again.
export function useIdleSession() {
  const { authStatus, session, t, toast } = useApp();
  const signedIn = authStatus === 'authed';
  const isCorporate = session === 'corporate';

  const monitor = useMemo(() => createIdleSession({ isBusy: () => isIdleHeld() || submissionTracker.isAwaitingAnswer() }), []);

  // What happens at the end of the time, with the language and account kind as they are now.
  useEffect(() => {
    monitor.setOnExpire(() => {
      toast(t('idle_signed_out'));
      signOutSession({ isCorporate }).catch(() => undefined);
    });
  }, [monitor, toast, t, isCorporate]);

  useEffect(() => {
    if (!signedIn) { monitor.stop(); return undefined; }
    monitor.start();
    return () => monitor.stop();
  }, [signedIn, monitor]);

  useEffect(() => subscribeAppActive(() => monitor.resume()), [monitor]);
  useEffect(() => subscribeWebActivity(() => monitor.touch()), [monitor]);
  // Typing is not a touch: the keyboard opening or closing counts as activity (the app's one keyboard store).
  const keyboardOpen = useKeyboardOpen();
  useEffect(() => { monitor.touch(); }, [keyboardOpen, monitor]);

  // Props for the root View: any touch that starts anywhere in the app, seen on its way down, before a child can take it.
  return useMemo(() => ({ viewProps: { onTouchStartCapture: () => monitor.touch() }, monitor }), [monitor]);
}
