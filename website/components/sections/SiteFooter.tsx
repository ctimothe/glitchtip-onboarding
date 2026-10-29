import { GITHUB_URL } from "@/lib/content";

export function SiteFooter() {
  return (
    <footer className="border-t border-white/10 px-6 py-10 text-center font-mono text-xs text-faint">
      <p>Privacy-first GlitchTip reporting for JavaScript and TypeScript applications.</p>
      <p className="mt-2">
        <a href={GITHUB_URL} className="underline decoration-white/20 underline-offset-4 hover:text-muted">
          Source and onboarding skill
        </a>
      </p>
    </footer>
  );
}
