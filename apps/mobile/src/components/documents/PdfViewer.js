import { createElement } from 'react';
import { Platform, View } from 'react-native';

// The in-app PDF viewer.
//   web:    the browser's own PDF viewer, in a frame (scrolling, many pages, zoom).
//   phone:  react-native-pdf, when the app build has it. It is a native module, so it exists only in a build made after it was added; it is
//           loaded inside a try so a build without it still opens (the preview then says that PDF preview is not available yet and offers Share).
let NativePdf = null;
if (Platform.OS !== 'web') {
  try {
    NativePdf = require('react-native-pdf').default;
  } catch {
    NativePdf = null;
  }
}

export const PDF_VIEWER_AVAILABLE = Platform.OS === 'web' || NativePdf !== null;

export function PdfViewer({ uri, title, onError }) {
  if (Platform.OS === 'web') {
    return (
      <View style={{ flex: 1 }}>
        {createElement('iframe', { src: uri, title, style: { border: 0, width: '100%', height: '100%', flex: 1 } })}
      </View>
    );
  }
  if (!NativePdf) return null;
  return (
    <NativePdf
      source={{ uri, cache: false }}
      style={{ flex: 1, backgroundColor: '#F2F6FC' }}
      trustAllCerts={false}
      onError={onError}
    />
  );
}
