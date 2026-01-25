import { Link } from "wouter";

export default function NotFound() {
  return (
    <div className="min-h-[60vh] grid place-items-center">
      <div className="rounded-2xl border border-border bg-card p-6 text-center">
        <div className="text-2xl font-semibold">404</div>
        <div className="text-sm text-muted-foreground mb-4">Page not found.</div>
        <Link href="/"><a className="rounded-lg bg-ysbPurple px-3 py-2 font-semibold text-ysbYellow">Go to Dashboard</a></Link>
      </div>
    </div>
  );
}
