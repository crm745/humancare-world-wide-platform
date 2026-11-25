import { useCallback } from 'react';
import { Linking } from 'react-native';
import { useApp } from '../state/AppContext';
import { openLink } from './openLink';

// The way a screen opens a phone number, an email or a web page: `open(url)`. If the phone cannot open it, a short message says so (data/i18n.json link_open_failed) instead of nothing happening.
export function useOpenLink() {
  const { t, toast } = useApp();
  return useCallback((url) => openLink(url, { open: (u) => Linking.openURL(u), onError: () => toast(t('link_open_failed')) }), [t, toast]);
}
