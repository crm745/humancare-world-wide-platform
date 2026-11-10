// Card + label/value list used by the details page. A core field with no value reads "Not
// provided" (it is not guessed); an `optional` one is simply left out.
export function DetailSection({ title, children, className = '' }) {
  return (
    <section className={`rounded-xl border border-slate-200 bg-white shadow-card ${className}`}>
      <h2 className="border-b border-slate-100 px-5 py-3 text-sm font-semibold text-ink">{title}</h2>
      <div className="px-5 py-4">{children}</div>
    </section>
  );
}

export function FieldList({ children }) {
  return <dl className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2">{children}</dl>;
}

const present = (value) => value !== null && value !== undefined && String(value).trim() !== '';

export function Field({ label, value, optional = false, wide = false, children }) {
  const content = children ?? value;
  if (optional && !present(content)) return null;
  return (
    <div className={wide ? 'sm:col-span-2' : undefined}>
      <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className="mt-1 whitespace-pre-line break-words text-sm text-slate-900">
        {present(content) ? content : <span className="text-slate-400">Not provided</span>}
      </dd>
    </div>
  );
}
