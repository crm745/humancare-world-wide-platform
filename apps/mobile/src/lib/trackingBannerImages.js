// The drawn picture on the Tracking Details banner, in ONE place: serviceKey -> { image, width, height, right, bottom, textMax }. Pure (no React, no native
// modules), so it can be unit-tested; the component maps an image name to the bundled file (assets/images/banner/<name>.png).
//
//   image      the file's name (assets/images/banner/<image>.png, bundled with the app: nothing is loaded from the network)
//   width/height  the size on a 390-wide screen, in px (the file's own aspect ratio)
//   right/bottom  the distance from the blue part's right and bottom edges, in px (left instead of right in Arabic)
//   textMax    how much of the card the title block may take: 0.55 beside a wide picture, 0.64 beside a narrow one
// A service that is not here has no picture: the banner is the blue background alone, with no placeholder.
const entry = (image, width, height, right, bottom, textMax) => Object.freeze({ image, width, height, right, bottom, textMax });

export const BANNER_IMAGES = Object.freeze({
  privatecharter: entry('banner-private-charter', 168, 63, 2, 6, 0.55),
  commercialair: entry('banner-medical-escort', 170, 54, 0, 10, 0.55),
  ground: entry('banner-ground-ambulance', 146, 74, 4, 6, 0.55),
  hospital: entry('banner-hospital', 124, 98, 8, 6, 0.64),
  homecare: entry('banner-home-healthcare', 132, 98, 8, 6, 0.64),
  tele: entry('banner-teleconsultation', 104, 106, 12, 6, 0.64),
  mortal: entry('banner-repatriation', 100, 106, 14, 6, 0.64),
  marine: entry('banner-marine', 156, 72, 2, 6, 0.55),
  medvalue: entry('banner-medical-travel', 104, 102, 12, 6, 0.64),
  corporate: entry('banner-corporate', 100, 104, 12, 6, 0.64),
});

// Older records can carry the generic "air" service; it is the Private Charter's plane, as everywhere else.
const ALIAS = { air: 'privatecharter' };

// The picture of a service, or null when it has none.
export function bannerImageFor(serviceKey) {
  if (typeof serviceKey !== 'string') return null;
  const key = ALIAS[serviceKey] || serviceKey;
  return Object.prototype.hasOwnProperty.call(BANNER_IMAGES, key) ? BANNER_IMAGES[key] : null;
}

export const DESIGN_WIDTH = 390;
export const TEXT_GAP = 6; // the least space between the text and the picture

// A screen narrower than 390 scales the picture (its size and its offsets) down in proportion.
export const scaleFor = (screenWidth) => (Number.isFinite(screenWidth) && screenWidth > 0 && screenWidth < DESIGN_WIDTH ? screenWidth / DESIGN_WIDTH : 1);

// Where the picture goes in the blue part, for this screen.
export function placeImage(image, screenWidth) {
  if (!image) return null;
  const s = scaleFor(screenWidth);
  return { width: Math.round(image.width * s), height: Math.round(image.height * s), right: Math.round(image.right * s), bottom: Math.round(image.bottom * s) };
}

export const SHORT_TITLE = 15; // up to this many characters a title is one line (it sits above a wide picture)

// How wide the title and the subtitle may be: the service's share of the card (55% / 64%), and never reaching the picture. A short title on a normal screen is one line above the picture and
// keeps its full share; anything that can wrap (a long title, a narrow screen) and the subtitle stop before the picture. With no picture the share is the 64%.
export function textWidths({ image, cardWidth, screenWidth, title }) {
  const share = Math.round(cardWidth * (image ? image.textMax : 0.64));
  if (!image) return { title: share, subtitle: share };
  const place = placeImage(image, screenWidth);
  const beside = Math.max(80, Math.min(share, cardWidth - 16 - place.width - place.right - TEXT_GAP));
  const wraps = String(title || '').length > SHORT_TITLE || scaleFor(screenWidth) < 1;
  return { title: wraps ? beside : Math.max(80, share), subtitle: beside };
}
