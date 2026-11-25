import { LegalScreen } from '../components/LegalScreen';

// Each section is [heading key, body key]: the text is in the dictionary (data/i18n.json), in every language. The legal wording in a language other than English is a translation that
// a legal reviewer must approve before release (the English text is the approved original).
const SECTIONS = [
  ['privacy_s1_h', 'privacy_s1_b'],
  ['privacy_s2_h', 'privacy_s2_b'],
  ['privacy_s3_h', 'privacy_s3_b'],
  ['privacy_s4_h', 'privacy_s4_b'],
  ['privacy_s5_h', 'privacy_s5_b'],
  ['privacy_s6_h', 'privacy_s6_b'],
  ['privacy_s7_h', 'privacy_s7_b'],
  ['legal_contact_h', 'privacy_s8_b'],
];

export default function Privacy() {
  return <LegalScreen titleKey="privacy_title" sections={SECTIONS} showUpdated={false} />;
}
