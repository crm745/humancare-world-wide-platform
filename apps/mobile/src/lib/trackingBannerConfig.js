// The Tracking Details banner's per-service chip, in ONE place: serviceKey -> { chip label, chip icon }. Pure (no React, no native modules), so it can be unit-tested.
//
//   chipKey   i18n key of the short label in the white chip ("Air Ambulance")
//   shortKey  i18n key of the short service name: the banner's title when the request has no route ("Home Healthcare")
//   icon      the service's own line icon (components/home/ServiceIcon.js, the same one as the Home "Our Services" tiles), in the chip
//
// The drawn picture on the blue part is configured in lib/trackingBannerImages.js.
export const BANNER_SERVICES = Object.freeze({
  privatecharter: Object.freeze({ chipKey: 'tb_chip_charter', shortKey: 'tb_short_charter', icon: 'privatecharter' }),
  commercialair: Object.freeze({ chipKey: 'tb_chip_commercial', shortKey: 'tb_short_commercial', icon: 'commercialair' }),
  ground: Object.freeze({ chipKey: 'tb_chip_ground', shortKey: 'tb_short_ground', icon: 'ground' }),
  homecare: Object.freeze({ chipKey: 'tb_chip_homecare', shortKey: 'tb_short_homecare', icon: 'homecare' }),
  hospital: Object.freeze({ chipKey: 'tb_chip_hospital', shortKey: 'tb_short_hospital', icon: 'hospital' }),
  tele: Object.freeze({ chipKey: 'tb_chip_tele', shortKey: 'tb_short_tele', icon: 'tele' }),
  mortal: Object.freeze({ chipKey: 'tb_chip_mortal', shortKey: 'tb_short_mortal', icon: 'mortal' }),
  marine: Object.freeze({ chipKey: 'tb_chip_marine', shortKey: 'tb_short_marine', icon: 'marine' }),
  medvalue: Object.freeze({ chipKey: 'tb_chip_medvalue', shortKey: 'tb_short_medvalue', icon: 'medvalue' }),
  corporate: Object.freeze({ chipKey: 'tb_chip_corporate', shortKey: 'tb_short_corporate', icon: 'corporate' }),
});

// A service this list does not know: a neutral chip and the hospital line icon (what ServiceIcon itself falls back to); its title is the full service name.
export const BANNER_FALLBACK = Object.freeze({ chipKey: 'tb_chip_other', shortKey: null, icon: 'hospital' });

// Older records can carry the generic "air" service; it is the Private Charter's plane, as everywhere else.
const ALIAS = { air: 'privatecharter' };

export function bannerConfigFor(serviceKey) {
  const key = ALIAS[serviceKey] || serviceKey;
  return Object.prototype.hasOwnProperty.call(BANNER_SERVICES, key) ? BANNER_SERVICES[key] : BANNER_FALLBACK;
}
