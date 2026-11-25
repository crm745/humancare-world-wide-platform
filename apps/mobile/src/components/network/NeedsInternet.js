import { View } from 'react-native';
import { useApp } from '../../state/AppContext';
import { useNetwork } from '../../state/NetworkContext';
import { Collapse } from './Collapse';
import { OfflineLine } from './OfflineLine';

// The one line under a button that needs the internet, shown while the phone is KNOWN to be offline (the same flag that switches the button pale: useNetwork().isOffline) and gone, with the same smooth
// motion, when the connection returns. It exists for screens with NO header (login, register, the password and code screens, ...): they have no connection banner, so without this line a pale button
// would give no reason. Its words are the banner's ("Connect to the internet to continue."); a screen can pass its own sentence.
export function NeedsInternet({ text }) {
  const { t } = useApp();
  const { isOffline } = useNetwork();
  return (
    <Collapse show={isOffline}>
      <View style={{ paddingTop: 10 }}><OfflineLine text={text || t('net_offline_text')} /></View>
    </Collapse>
  );
}
