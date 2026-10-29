import { transportTrio } from "@/lib/content";
import { BeatSplit } from "@/components/ui/BeatSplit";
import { CodeBlock } from "@/components/ui/CodeBlock";

export function Beat2Transport() {
  return (
    <BeatSplit
      id="beat-2"
      side="left"
      glow="info"
      kicker="02 · Transport"
      title="Sentry-compatible transport"
      panel={<CodeBlock code={transportTrio.code} lang={transportTrio.lang} />}
    >
      <p>The same three calls everywhere. Errors carry stack traces; warnings and info carry stable fingerprints.</p>
    </BeatSplit>
  );
}
