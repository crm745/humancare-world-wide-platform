// The browser's boot picture (public/index.html, the #boot overlay) is removed by the app, once the app's own first screen is really on screen. Web only: on a phone there is no such element.
// hideBootSplash is safe to call any number of times, anywhere.
export const BOOT_FADE_MS = 250; // the same as the overlay's CSS transition
export const BOOT_MAX_MS = 4000; // it is never left up longer than this, whatever happens (a picture that never loads, an error)

export function hideBootSplash() {
  if (typeof document === 'undefined' || !document.getElementById) return false;
  const element = document.getElementById('boot');
  if (!element || element.classList.contains('hide')) return false;
  element.classList.add('hide');
  setTimeout(() => { if (element.parentNode) element.parentNode.removeChild(element); }, BOOT_FADE_MS + 50);
  return true;
}
