import { JourneyProgress } from "@/components/Scene/JourneyProgress";
import { ExperienceSwitch } from "@/components/Scene/ExperienceSwitch";
import { ScrollChoreo } from "@/components/choreo/ScrollChoreo";
import { SiteNav } from "@/components/sections/SiteNav";
import { SiteFooter } from "@/components/sections/SiteFooter";
import { Beat0Hero } from "@/components/sections/Beat0Hero";
import { Beat1Capture } from "@/components/sections/Beat1Capture";
import { Beat2Transport } from "@/components/sections/Beat2Transport";
import { Beat3Groups } from "@/components/sections/Beat3Groups";
import { Beat4Scrub } from "@/components/sections/Beat4Scrub";
import { Beat5Relay } from "@/components/sections/Beat5Relay";
import { Beat6Human } from "@/components/sections/Beat6Human";

export default function Page() {
  return (
    <JourneyProgress>
      <ScrollChoreo />
      <SiteNav />
      <ExperienceSwitch />
      <main>
        <Beat0Hero />
        <Beat1Capture />
        <Beat2Transport />
        <Beat3Groups />
        <Beat4Scrub />
        <Beat5Relay />
        <Beat6Human />
      </main>
      <SiteFooter />
    </JourneyProgress>
  );
}
