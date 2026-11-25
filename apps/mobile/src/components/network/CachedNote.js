import { useApp } from '../../state/AppContext';
import { useNetwork } from '../../state/NetworkContext';
import { Text } from '../ui';

// A list that is showing what an earlier visit loaded (lib/useResource.js keeps it for the session) says so while the phone is offline: one small line under the list. Online it is not drawn.
export function CachedNote({ style }) {
  const { t } = useApp();
  const { isOffline } = useNetwork();
  if (!isOffline) return null;
  return <Text style={[{ marginTop: 4, fontFamily: 'Inter_400Regular', fontSize: 12.5, lineHeight: 17, color: '#5B6B84' }, style]}>{t('net_cached_note')}</Text>;
}
