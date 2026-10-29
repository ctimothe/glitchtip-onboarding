import { relayFixture } from "@/lib/content";
import { BeatSplit } from "@/components/ui/BeatSplit";
import { SeverityBadge } from "@/components/ui/SeverityBadge";

export function Beat5Relay() {
  return (
    <BeatSplit
      id="beat-5"
      side="right"
      glow="error"
      kicker="05 · Relay"
      title="Severity routes to Telegram"
      panel={
        <div className="space-y-3">
          <div className="flex gap-2">
            <SeverityBadge severity="error" />
            <SeverityBadge severity="warning" />
            <SeverityBadge severity="info" />
          </div>
          <div className="rounded-xl border border-white/10 bg-black/40 p-4 font-mono text-[13px] leading-relaxed text-ink">
            <p className="font-semibold">{relayFixture.header.replace(/<[^>]+>/g, "")}</p>
            <p className="mt-1">{relayFixture.title}</p>
            {relayFixture.rows.map((row) => (
              <p key={row} className="text-muted">{row}</p>
            ))}
            <p className="mt-1 text-muted">⛔ Source: {relayFixture.source}</p>
          </div>
        </div>
      }
    >
      <p>The relay turns GlitchTip webhooks into severity-colored Telegram alerts — red errors, amber warnings, blue info.</p>
    </BeatSplit>
  );
}
