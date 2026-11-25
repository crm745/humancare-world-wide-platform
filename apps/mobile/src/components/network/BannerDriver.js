import { useEffect } from 'react';
import { useNetwork } from '../../state/NetworkContext';
import { bannerPresenter } from '../../lib/bannerPresenter';

// Feeds the app's one network state (lib/network.js, through useNetwork()) to the banner presenter (lib/bannerPresenter.js). Mounted ONCE, in the root layout; it draws nothing.
// The banners themselves (components/network/ConnectionBanner.js, one under each header) only read what the presenter says, so the banner lives across screens instead of starting
// over with every page that opens.
export function BannerDriver() {
  const { status } = useNetwork();
  useEffect(() => { bannerPresenter.observe(status); }, [status]);
  return null;
}
