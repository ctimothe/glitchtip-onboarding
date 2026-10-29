import { highlight } from "@/lib/highlight";
import { windowChrome } from "@/theme/tokens";

const LANG_LABEL: Record<string, string> = {
  ts: "TS",
  tsx: "TSX",
  bash: "Bash",
  json: "JSON",
  python: "Python",
  diff: "Diff",
};

export async function CodeBlock({ code, lang }: { code: string; lang: string }) {
  const html = await highlight(code, lang);
  return (
    <div className="overflow-hidden rounded-lg border border-white/10 bg-black/50">
      <div className="flex items-center gap-1.5 border-b border-white/10 bg-white/[0.04] px-3 py-2">
        <span aria-hidden className="size-3 rounded-full" style={{ background: windowChrome.close }} />
        <span aria-hidden className="size-3 rounded-full" style={{ background: windowChrome.minimize }} />
        <span aria-hidden className="size-3 rounded-full" style={{ background: windowChrome.zoom }} />
        <span className="ml-2 font-mono text-[11px] uppercase tracking-widest text-faint">
          {LANG_LABEL[lang] ?? lang.toUpperCase()}
        </span>
      </div>
      <div
        className="whitespace-pre-wrap break-words p-4 font-mono text-[13px] leading-relaxed [&_pre]:whitespace-pre-wrap [&_pre]:break-words [&_pre]:!overflow-visible [&_pre]:!bg-transparent [&_code]:!bg-transparent"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}
