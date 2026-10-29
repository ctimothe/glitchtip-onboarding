import { relayFixture } from "@/lib/content";
import { BeatSplit } from "@/components/ui/BeatSplit";

export function Beat3Groups() {
  return (
    <BeatSplit
      id="beat-3"
      side="right"
      glow="warning"
      kicker="03 · Store + Group"
      title="GlitchTip groups the noise"
      panel={
        <div className="rounded-lg border border-white/10 bg-black/40 p-4">
          {/* Count + project shape per the impact block in assets/relay/format.js (formatEnriched). */}
          <p className="font-mono text-[13px] font-semibold text-ink">
            {relayFixture.header.replace(/<[^>]+>/g, "")}
          </p>
          <p className="mt-1 font-mono text-[13px] text-muted">{relayFixture.title}</p>
          <p className="mt-2 font-mono text-xs text-faint">3 events · 1 issue</p>
        </div>
      }
    >
      <p>
        Identical events collapse into issues that carry event counts and affected-user totals, so one
        Telegram alert can say “3× in billing-api” instead of paging three times for the same crash.
      </p>
    </BeatSplit>
  );
}
