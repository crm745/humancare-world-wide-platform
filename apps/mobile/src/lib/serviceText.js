// What the Service Detail page says, in the person's language. data/services.json holds the English text (and the service names that are SENT with a request, so it is not changed); every text
// of it has a dictionary key: sd_<service>_title / _desc / _f1..f4, and the stat labels and values with words in them. Anything without a key (a number like "3,500+") is shown as it is.
export const STAT_LABEL_KEYS = Object.freeze({
  "Years Experience": 'sd_stat_years',
  "Critical Transfers": 'sd_stat_critical',
  "Control Rooms": 'sd_stat_control',
  "Countries Covered": 'sd_stat_countries',
  "Avg Response Time": 'sd_stat_response',
  "Active Deployments": 'sd_stat_deployments',
  "Medical Facilities": 'sd_stat_facilities',
  "Hospital Coordination": 'sd_stat_hosp_coord',
  "Transfers Completed": 'sd_stat_transfers',
  "Cost Savings": 'sd_stat_savings',
  "Airborne Response": 'sd_stat_airborne',
  "Repatriations Handled": 'sd_stat_repatriations',
  "Typical Turnaround": 'sd_stat_turnaround',
  "Branches Worldwide": 'sd_stat_branches',
  "Cities Covered": 'sd_stat_cities',
  "Patients Supported": 'sd_stat_patients',
  "ICU Setup Time": 'sd_stat_icu_setup',
  "Doctor Access": 'sd_stat_doctor',
  "Patient Coordination": 'sd_stat_patient_coord',
  "Employees Monitored": 'sd_stat_employees',
  "Continents Served": 'sd_stat_continents',
});
export const STAT_VALUE_KEYS = Object.freeze({
  "45 min": 'sd_val_45min',
  "Up to 60%": 'sd_val_up60',
  "<4 hrs": 'sd_val_lt4h',
  "<72 hrs": 'sd_val_lt72h',
  "4–6 hrs": 'sd_val_4to6h',
  "30 min": 'sd_val_30min',
});

// The dictionary text of a key, or `fallback` when the language has none (the dictionary returns the key itself then).
const word = (t, key, fallback) => { const text = t(key); return text && text !== key ? text : fallback; };

// `local`: the service's bundled content (data/services.json); `serviceKey`: its key there ("air", "ground" ...).
export function localizedServiceContent(local, serviceKey, t) {
  return {
    title: word(t, `sd_${serviceKey}_title`, local.title),
    desc: word(t, `sd_${serviceKey}_desc`, local.desc),
    features: local.features.map((f, i) => word(t, `sd_${serviceKey}_f${i + 1}`, f)),
    stats: local.stats.map((s) => ({
      value: STAT_VALUE_KEYS[s.value] ? word(t, STAT_VALUE_KEYS[s.value], s.value) : s.value,
      label: STAT_LABEL_KEYS[s.label] ? word(t, STAT_LABEL_KEYS[s.label], s.label) : s.label,
    })),
  };
}
