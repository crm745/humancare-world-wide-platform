/* global describe, test, expect, __dirname */
// A Pressable's style must never be a function in this app: on the phone the NativeWind layer drops it, and the card, row or button loses
// its whole look (see components/PressBox.js). Anything that needs `pressed` uses PressBox, which works the function out itself.
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '../..');
function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) { if (name !== '__tests__') walk(full, out); } else if (name.endsWith('.js')) out.push(full);
  }
  return out;
}

describe('no Pressable has a function style', () => {
  test('every app and component file: a function style on a Pressable is written as PressBox instead', () => {
    const hits = [];
    for (const file of walk(SRC)) {
      const text = fs.readFileSync(file, 'utf8');
      const lines = text.split('\n');
      lines.forEach((line, i) => {
        if (line.trim().startsWith('//')) return;
        if (!/style=\{\(\{ pressed|style=\{\(pressed\)|style=\{\(state\)/.test(line)) return;
        // the nearest opening tag above must be a PressBox
        const above = lines.slice(Math.max(0, i - 12), i + 1).join('\n');
        const idx = Math.max(above.lastIndexOf('<Pressable'), above.lastIndexOf('<PressBox'));
        if (idx < 0 || !above.startsWith('<PressBox', idx)) hits.push(`${path.relative(SRC, file)}:${i + 1}`);
      });
    }
    expect(hits).toEqual([]);
  });
  test('the components that lost their look on the phone use PressBox', () => {
    for (const file of ['app/all-services.js', 'app/profile.js', 'app/request-details.js', 'components/requests/RequestCard.js', 'components/requests/RequestsHeader.js', 'components/sos/SosFab.js', 'components/tracking/TrackingDetails.js', 'components/ui.js']) {
      expect(fs.readFileSync(path.join(SRC, file), 'utf8')).toContain('<PressBox');
    }
  });
  test('PressBox hands Pressable a plain style object and tracks pressed itself', () => {
    const box = fs.readFileSync(path.join(SRC, 'components/PressBox.js'), 'utf8');
    expect(box).toContain("typeof style === 'function' ? style({ pressed }) : style");
    expect(box).toContain('style={resolved}');
    expect(box).toContain('onPressIn=');
    expect(box).toContain('onPressOut=');
  });
});
