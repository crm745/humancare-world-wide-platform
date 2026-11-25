import { CircleAlert, CircleCheck, CloudOff, Hourglass, Info, ShieldCheck, Signal, Smartphone, Wifi, WifiOff } from 'lucide-react-native';

// The icons of the network design, by name (lib/networkUi.js and lib/cantConnect.js name them; nothing else picks one).
export const NETWORK_ICONS = Object.freeze({
  wifiOff: WifiOff,
  cloudOff: CloudOff,
  signal: Signal,
  wifi: Wifi,
  hourglass: Hourglass,
  device: Smartphone,
  alert: CircleAlert,
  info: Info,
  check: CircleCheck,
  shield: ShieldCheck,
});
