export function AuthHeading({ title, children }) {
  return (
    <div className="mb-7 text-center">
      <h1 className="text-2xl font-bold tracking-tight text-brand-950 sm:text-[1.75rem]">{title}</h1>
      {children && <p className="mt-2 text-sm leading-relaxed text-slate-500">{children}</p>}
    </div>
  );
}
