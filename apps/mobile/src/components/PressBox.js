import { useState } from 'react';
import { Pressable } from 'react-native';

// A Pressable whose style may depend on whether it is pressed, written the way Pressable allows: style={({ pressed }) => ({ ... })}.
//
// Why it exists: on the phone (Android and iOS builds) the app's NativeWind layer drops a Pressable's style when it is a function, so a
// card, a row or a button written that way lost its whole look (its background, border, padding and row layout) and the button's
// colour. The web does not do that, which is why it was missed there. This component works the function out itself and hands
// Pressable a plain style object, which NativeWind keeps. Use it, and not a function style on Pressable, wherever a style needs `pressed`.
export function PressBox({ style, onPressIn, onPressOut, ...props }) {
  const [pressed, setPressed] = useState(false);
  const resolved = typeof style === 'function' ? style({ pressed }) : style;
  return (
    <Pressable
      {...props}
      style={resolved}
      onPressIn={(e) => { setPressed(true); if (onPressIn) onPressIn(e); }}
      onPressOut={(e) => { setPressed(false); if (onPressOut) onPressOut(e); }}
    />
  );
}
