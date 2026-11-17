export function PageHeading({ title, description }: { title: string; description?: string }) {
  return (
    <div className="mb-6">
      <h1 className="text-primary-foreground text-2xl font-bold tracking-widest uppercase">
        {title}
      </h1>
      {description && <p className="text-foreground/70 mt-1">{description}</p>}
    </div>
  );
}
