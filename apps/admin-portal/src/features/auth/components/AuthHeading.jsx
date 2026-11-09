export function AuthHeading({ title, children }) {
  return (
    <div className="mb-6 text-center">
      <h1 className="text-2xl font-bold tracking-tight text-ink">{title}</h1>
      {children && <p className="mt-1 text-sm text-slate-500">{children}</p>}
    </div>
  );
}
