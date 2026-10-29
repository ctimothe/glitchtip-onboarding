import { GITHUB_URL, INSTALL_CMD, hero } from "@/lib/content";
import { InstallPill } from "@/components/ui/InstallPill";

export function Beat0Hero() {
  return (
    <section id="top" className="flex min-h-screen items-center px-6 md:px-16">
      <div className="w-full max-w-2xl">
        <p className="font-mono text-xs uppercase tracking-widest text-delivered">GlitchTip observability, end to end</p>
        <h1 className="mt-3 font-display text-5xl font-semibold leading-tight text-ink md:text-6xl">{hero.title}</h1>
        <p className="mt-4 max-w-xl text-lg text-muted">{hero.sub}</p>
        <div className="hero-cta mt-6 flex flex-wrap items-center gap-3">
          <InstallPill command={INSTALL_CMD} />
          <a href={GITHUB_URL} className="rounded-full bg-ink px-4 py-2 font-mono text-sm text-void">
            Get the SDK
          </a>
        </div>
      </div>
    </section>
  );
}
