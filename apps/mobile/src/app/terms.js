import { LegalScreen } from '../components/LegalScreen';

// Each section is [heading key, body key]: the text is in the dictionary (data/i18n.json), in every language. The legal wording in a language other than English is a translation that
// a legal reviewer must approve before release (the English text is the approved original).
const SECTIONS = [
  ['terms_s1_h', 'terms_s1_b'],
  ['terms_s2_h', 'terms_s2_b'],
  ['terms_s3_h', 'terms_s3_b'],
  ['terms_s4_h', 'terms_s4_b'],
  ['terms_s5_h', 'terms_s5_b'],
  ['terms_s6_h', 'terms_s6_b'],
  ['terms_s7_h', 'terms_s7_b'],
  ['legal_contact_h', 'terms_s8_b'],
];

export default function Terms() {
  return <LegalScreen titleKey="terms_title" sections={SECTIONS} showUpdated={false} />;
}
