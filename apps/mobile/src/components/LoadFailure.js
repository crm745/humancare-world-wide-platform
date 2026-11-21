import { useApp } from '../state/AppContext';
import { useNetwork } from '../state/NetworkContext';
import { loadFailureView } from '../lib/networkUi';
import { StateView } from './network/StateView';
import { Reveal } from './skeleton/Reveal';

// What a screen shows when its first load failed and there is nothing to display: the shared "could not load" layout (components/network/StateView.js) with the screen's own title
// ("Couldn't load your requests"), one sentence that says what really went wrong, and a filled "Try again" (the skeleton never stays for ever). `onRetry` runs the load again.
//
// The sentence and the icon say what actually went wrong when that is known (lib/networkUi.js loadFailureView): no internet, the servers cannot be reached, or the server took too long. It is never
// the raw "Network request failed". Anything else (a refusal, a missing item) keeps the screen's own `message`.
// `titleKey` is the screen's title (data/i18n.json lf_title_*). `error` is optional: a screen that only knows it failed still gets the network wording when the network state says so.
// "Try again" is a read, so it stays available even offline.
export function LoadFailure({ message, error, onRetry, titleKey }) {
  const { t } = useApp();
  const net = useNetwork();
  const view = loadFailureView({ error, net, screenTitleKey: titleKey });
  const body = view.bodyKey ? t(view.bodyKey) : (message || t('sk_load_failed'));
  // It replaces the skeleton with a cross-fade (Reveal: fade + a 6 px rise), not a hard cut.
  return (
    <Reveal animate>
    <StateView
      icon={view.icon} title={t(view.titleKey)} body={body}
      retryLabel={onRetry ? t('sk_try_again') : undefined} onRetry={onRetry}
      style={{ paddingVertical: 56 }}
    />
    </Reveal>
  );
}
