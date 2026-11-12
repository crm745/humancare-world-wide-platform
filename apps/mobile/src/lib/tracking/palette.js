// The colours of the Tracking screen, in one place. Official HumanCare logo blue and its secondary navy, plus
// the app's own neutral and state colours (the same values as tailwind.config.js and the shared components), so
// Tracking sits in the same design system as Home and Request Details. Used only by the Tracking screen: the rest
// of the app keeps its own tokens.
export const TRACKING_PALETTE = {
  brand: '#303A8F', // official primary logo blue: active step, progress, status chip, route markers
  brandSoft: '#E9EAF4', // the blue's light tint (status chip background)
  navy: '#2F2A62', // official secondary navy: the destination marker
  done: '#1E8E4A', // completed steps (the app's success colour)
  doneSoft: '#E4F7EA',
  cancelled: '#C23B3B', // the app's muted red for a cancelled request
  cancelledSoft: '#FBE9E9',
  brandOnDark: '#A9B3F0', // the brand blue's light tint, for lines and markers on the blue route card
  doneOnDark: '#8FE0AB',
  cancelledOnDark: '#F4A3A3',
  dash: '#C9D3E1', // the dotted part of the route (the same grey as Home's active-request route)
  line: '#E4E9F2', // borders, the unfinished part of a line, a pending indicator's ring
  faint: '#97A4B8', // pending text
  muted: '#5B6B84', // supporting text
  ink: '#17233D', // body text
  heading: '#0D2340', // headings
};

// The colours for the status chip and the route line of a request: red when it was cancelled, green when it is
// completed, the brand blue while it is in progress.
export function toneFor(view) {
  const p = TRACKING_PALETTE;
  // `onDark` is the same tone, lightened, for the route card, which sits on the brand blue.
  if (view.cancelled) return { text: p.cancelled, soft: p.cancelledSoft, solid: p.cancelled, onDark: p.cancelledOnDark };
  if (view.steps.every((s) => s.state === 'done')) return { text: p.done, soft: p.doneSoft, solid: p.done, onDark: p.doneOnDark };
  return { text: p.brand, soft: p.brandSoft, solid: p.brand, onDark: p.brandOnDark };
}
