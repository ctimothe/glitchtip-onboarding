import { quickstartTabs } from "@/lib/content";
import { BeatSplit } from "@/components/ui/BeatSplit";
import { CodeBlock } from "@/components/ui/CodeBlock";
import { Tabs } from "@/components/ui/Tabs";

export function Beat1Capture() {
  return (
    <BeatSplit
      id="beat-1"
      side="right"
      glow="error"
      kicker="01 · Capture"
      title="One reporter, every runtime"
      panel={
        <Tabs
          tabs={quickstartTabs.map((tab) => ({
            id: tab.id,
            label: tab.label,
            content: <CodeBlock code={tab.code} lang={tab.lang} />,
          }))}
        />
      }
    >
      <p>Catch errors where they happen — Node, browser, React, Next.js, Express, NestJS, Fastify.</p>
    </BeatSplit>
  );
}
