import { Pressable, Text as RNText, TextInput, View } from 'react-native';
import { Check } from 'lucide-react-native';
import { useApp } from '../state/AppContext';
import { Spinner } from './Spinner';
import { COLORS } from '../theme/colors';
import { PressBox } from './PressBox';

const HAS_COLOR = /(^|\s)text-(navy|ink|slate|muted|faint|white|primary|success|danger|warning|cancel|scheduled)/;
const HAS_FONT = /(^|\s)font-inter/;

// Which utility group a class belongs to, for the groups components let callers override.
const groupOf = (cls) => (cls.match(/^(px|py|pt|pb|p|h|w|rounded|bg)(-|$)/) || [])[1];

// Merge a component's default classes with caller overrides: a default is dropped when the
// caller passes a class from the same group (e.g. `p-0` replaces `p-3.5`), since NativeWind
// doesn't resolve such conflicts by order.
export function cx(defaults, overrides = '') {
  const taken = new Set(overrides.split(/\s+/).map(groupOf).filter(Boolean));
  return `${defaults.split(/\s+/).filter((c) => !taken.has(groupOf(c))).join(' ')} ${overrides}`;
}

// Text with the app's defaults (Inter, ink colour). Pass font-inter-* / text-* classes to override.
export function Text({ className = '', ...props }) {
  const defaults = `${HAS_FONT.test(className) ? '' : 'font-inter'} ${HAS_COLOR.test(className) ? '' : 'text-ink'}`;
  return <RNText className={`${defaults} ${className}`} {...props} />;
}

export function Heading({ className = '', ...props }) {
  return <Text className={`font-inter-black text-navy ${className}`} {...props} />;
}

const BUTTON = {
  primary: { box: 'bg-primary', text: 'text-white text-[15px]', spinner: '#fff' },
  outline: { box: 'bg-white border-[1.5px] border-primary', text: 'text-primary text-[14.5px]', spinner: COLORS.primary },
  ghost: { box: 'bg-transparent border-[1.5px] border-field', text: 'text-slate text-[14px]', spinner: '#45526B' },
  danger: { box: 'bg-white border-[1.5px] border-danger-line', text: 'text-danger text-[14.5px]', spinner: '#D64545' },
  sos: { box: 'bg-danger', text: 'text-white text-[14px]', spinner: '#fff' },
};

// `dimmed` reproduces the prototype's 45%-opacity "not ready yet" buttons, which stay
// tappable (so a tap can still surface a validation message). `loading` is different —
// a request is genuinely in flight, so the button is actually disabled (no double-submits)
// and shows a spinner instead of the icon.
// `dimmed` only looks inactive (the press still runs, so it can explain what's missing);
// `disabled` also blocks the press.
export function Button({ title, onPress, variant = 'primary', dimmed, disabled, loading, large, icon, className = '', textClassName = '' }) {
  const v = BUTTON[variant];
  const faded = dimmed || disabled || loading;
  const shadow = variant === 'primary' && !faded
    ? { shadowColor: COLORS.primary, shadowOpacity: 0.28, shadowRadius: 10, shadowOffset: { width: 0, height: 8 }, elevation: 4 }
    : null;
  return (
    <PressBox
      onPress={onPress}
      disabled={loading || disabled}
      style={({ pressed }) => [shadow, pressed && variant === 'primary' && !faded ? { backgroundColor: COLORS.primaryPressed } : null]}
      className={cx(`flex-row items-center justify-center gap-1.5 rounded-xl ${large ? 'py-4' : 'py-3.5'} ${v.box} ${faded ? 'opacity-45' : 'active:opacity-85'}`, className)}
    >
      {loading ? <Spinner size={large ? 19 : 16} color={v.spinner} /> : icon}
      <Text className={`font-inter-bold ${v.text} ${large ? 'text-[16.5px]' : ''} ${textClassName}`}>{title}</Text>
    </PressBox>
  );
}

export function Card({ className = '', style, children, onPress }) {
  const cls = cx('bg-white border border-line rounded-2xl p-3.5', className);
  if (onPress) return <Pressable onPress={onPress} style={style} className={`${cls} active:opacity-80`}>{children}</Pressable>;
  return <View style={style} className={cls}>{children}</View>;
}

const PILL = {
  progress: 'bg-primary-soft text-primary-dark',
  submitted: 'bg-warning-soft text-warning',
  completed: 'bg-success-soft text-success',
  cancelled: 'bg-cancel-soft text-cancel',
  scheduled: 'bg-scheduled-soft text-scheduled',
};

export function Pill({ status }) {
  const { t } = useApp();
  const [bg, fg] = PILL[status].split(' ');
  return (
    <View className={`rounded-full px-2.5 py-1 ${bg}`}>
      <Text className={`font-inter-black text-[11.5px] uppercase tracking-wide ${fg}`}>{t('status_' + status)}</Text>
    </View>
  );
}

export function Chip({ label, on, onPress, className = '', textClassName = '' }) {
  return (
    <Pressable
      onPress={onPress}
      className={cx(`rounded-full border px-3.5 py-2 ${on ? 'bg-ink border-ink' : 'bg-white border-field'}`, className)}
    >
      <Text className={`font-inter-bold text-[12.5px] text-center ${on ? 'text-white' : 'text-muted'} ${textClassName}`}>{label}</Text>
    </Pressable>
  );
}

// Row of mutually exclusive chips; `options` is [{ value, label }].
export function ChipGroup({ options, value, onChange, wrap = true, className = '' }) {
  return (
    <View className={`flex-row gap-2 ${wrap ? 'flex-wrap' : ''} ${className}`}>
      {options.map((o) => (
        <Chip key={o.value} label={o.label} on={o.value === value} onPress={() => onChange(o.value)} />
      ))}
    </View>
  );
}

// 2x2 single-select "Care Level" grid (request form and corporate new-case form).
// A patient is only ever in one of these states at a time, so `value` is a single
// key (or '' when none chosen yet) — tapping the already-selected one clears it.
export const CARE_LEVELS = ['care_icu', 'care_stable', 'care_ambulatory', 'care_na'];
export function CareLevelGrid({ value, onChange }) {
  const { t } = useApp();
  return (
    <View className="flex-row flex-wrap justify-between gap-y-2.5">
      {CARE_LEVELS.map((k) => (
        <Chip key={k} label={t(k)} on={value === k} onPress={() => onChange(value === k ? '' : k)} className="w-[48.5%] rounded-full py-3.5" />
      ))}
    </View>
  );
}

// Label/value classes replace the defaults rather than append, so colours never conflict.
export function InfoRow({ label, value, valueNode, onPress, last, className = '', labelClassName = 'text-[12.5px] text-faint', valueClassName = 'text-ink' }) {
  const Box = onPress ? Pressable : View;
  return (
    <Box onPress={onPress} className={`flex-row justify-between items-center gap-3 py-2.5 ${last ? '' : 'border-b border-divider'} ${className}`}>
      <Text className={labelClassName}>{label}</Text>
      {valueNode || <Text className={`font-inter-bold text-[13.5px] text-right flex-shrink ${valueClassName}`}>{value}</Text>}
    </Box>
  );
}

export function SectionLabel({ children, className = '' }) {
  return <Text className={`font-inter-black text-[12.5px] text-primary uppercase tracking-wider mb-2.5 ${className}`}>{children}</Text>;
}

export function FieldLabel({ children, large, required, className = '' }) {
  return (
    <Text className={`font-inter-bold ${large ? 'text-[14px]' : 'text-[12.5px]'} text-slate mb-1.5 ${className}`}>
      {children}{required ? <Text className="text-danger"> *</Text> : null}
    </Text>
  );
}

// bare drops the border/background/radius so the input can sit inside a custom
// grouped container (e.g. login's stacked country+number card) instead of looking
// like its own separate field.
export function Input({ large, multiline, bare, className = '', ...props }) {
  return (
    <TextInput
      placeholderTextColor="#97A4B8"
      multiline={multiline}
      textAlignVertical={multiline ? 'top' : 'center'}
      className={cx(`min-w-0 font-inter text-ink ${bare ? '' : 'bg-input border-[1.5px] border-field rounded-[10px]'} ${large ? 'text-[16.5px] px-3 py-3.5' : 'text-[15px] px-3 py-3'} ${multiline ? 'min-h-[84px]' : ''}`, className)}
      {...props}
    />
  );
}

export function Field({ label, large, required, error, className = '', ...inputProps }) {
  return (
    <View className={className}>
      <FieldLabel large={large} required={required}>{label}</FieldLabel>
      <Input large={large} {...inputProps} />
      {error ? <Text className="mt-1 text-[12px] text-danger">{error}</Text> : null}
    </View>
  );
}

export function Consent({ on, onToggle, children }) {
  return (
    <Pressable onPress={onToggle} className="flex-row items-start gap-2.5">
      <View className={`mt-0.5 h-[19px] w-[19px] items-center justify-center rounded-[5px] border-2 border-success-check ${on ? 'bg-success-check' : ''}`}>
        {on && <Check size={11} color="#fff" strokeWidth={3} />}
      </View>
      <View className="flex-1">{children}</View>
    </Pressable>
  );
}

export function Spacer({ min = 24 }) {
  return <View className="flex-1" style={{ minHeight: min }} />;
}
