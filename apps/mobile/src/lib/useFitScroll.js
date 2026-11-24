import { useState } from 'react';

// A screen that shows a "Couldn't load ..." view (components/LoadFailure.js) must not scroll when that view fits: there is nothing to scroll to, and a page that moves under the finger looks broken.
// `active` is true while the failure view is on screen. Then scrolling is switched off, unless the content really is taller than the room (a very small phone or a very large font), when it is
// kept so the "Try again" button can always be reached. When `active` is false the screen scrolls as it always did. The scroll view's own size and its content's size are what is compared.
export const scrollNeeded = ({ viewHeight, contentHeight }) => contentHeight > viewHeight + 1;

export function useFitScroll(active) {
  const [size, setSize] = useState({ view: 0, content: 0 });
  return {
    scrollEnabled: !active || scrollNeeded({ viewHeight: size.view, contentHeight: size.content }),
    onLayout: (e) => { const view = e.nativeEvent.layout.height; setSize((s) => (s.view === view ? s : { ...s, view })); },
    onContentSizeChange: (_w, content) => setSize((s) => (s.content === content ? s : { ...s, content })),
  };
}
