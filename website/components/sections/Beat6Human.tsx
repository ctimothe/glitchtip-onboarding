import { GITHUB_URL, verifyFacts } from "@/lib/content";
import { BeatSplit } from "@/components/ui/BeatSplit";
import { CodeBlock } from "@/components/ui/CodeBlock";
import { Terminal } from "@/components/ui/Terminal";

export function Beat6Human() {
  return (
    <BeatSplit
      id="beat-6"
      side="left"
      glow="delivered"
      kicker="06 · Reach a human"
      title="Proven, not promised"
      panel={
        <div className="space-y-3">
          <CodeBlock code={verifyFacts.command} lang="bash" />
          <Terminal
            lines={[
              { text: "[PASS] synthetic error stored as an issue", pass: true },
              { text: "[PASS] Telegram alert arrived with context", pass: true },
              { text: "[PASS] check 6 — no user data in the stored event", pass: true },
            ]}
          />
          <a href={GITHUB_URL} className="inline-block rounded-full bg-ink px-4 py-2 font-mono text-sm text-void">
            Star it when it goes public
          </a>
        </div>
      }
    >
      <p>{verifyFacts.verdict} A synthetic event marked “{verifyFacts.marker}” travels the whole pipeline.</p>
      <p className="text-sm text-faint">{verifyFacts.check6}</p>
    </BeatSplit>
  );
}
