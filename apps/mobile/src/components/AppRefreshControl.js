import { RefreshControl } from 'react-native';
import { COLORS } from '../theme/colors';

// The pull-to-refresh control of every data screen: the phone's own RefreshControl (not a custom gesture). Android shows the white circle
// with a spinning brand-blue arc; iOS shows its own spinner tinted brand blue. On the web it does nothing and breaks nothing.
// `refreshing` must be true only while a pull is in progress (see lib/useResource.js).
// It passes every other prop on: the web ScrollView hands the scroll content to its refresh control as `children`, and a wrapper that dropped
// them would show an empty screen.
export function AppRefreshControl({ refreshing, onRefresh, ...rest }) {
  return (
    <RefreshControl
      {...rest}
      refreshing={refreshing}
      onRefresh={onRefresh}
      tintColor={COLORS.primary}
      colors={[COLORS.primary]}
      progressBackgroundColor="#FFFFFF"
    />
  );
}
