import { scrubFixture } from "@/lib/content";
import { BeatSplit } from "@/components/ui/BeatSplit";
import { CodeBlock } from "@/components/ui/CodeBlock";

export function Beat4Scrub() {
  return (
    <BeatSplit
      id="beat-4"
      side="left"
      glow="delivered"
      kicker="04 · Scrub"
      title="PII never leaves the box"
      panel={
        <div className="space-y-3">
          <div>
            <p className="mb-1 font-mono text-xs text-faint">before</p>
            <CodeBlock code={scrubFixture.before} lang={scrubFixture.lang} />
          </div>
          <div>
            <p className="mb-1 font-mono text-xs text-faint">after</p>
            <CodeBlock code={scrubFixture.after} lang={scrubFixture.lang} />
          </div>
        </div>
      }
    >
      <p>Scrubbing runs in the process before transport: sensitive keys, emails, bearer tokens, and credential shapes become <span className="font-mono text-sm">[REDACTED]</span>.</p>
    </BeatSplit>
  );
}
