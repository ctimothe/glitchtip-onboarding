import type { Metadata } from "next";
import { Inter, JetBrains_Mono, Space_Grotesk } from "next/font/google";
import "./globals.css";

const display = Space_Grotesk({ subsets: ["latin"], variable: "--font-display" });
const body = Inter({ subsets: ["latin"], variable: "--font-body" });
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-mono" });

export const metadata: Metadata = {
  title: "glitchtip-onboarding — a real error reaches a human",
  description:
    "Privacy-first GlitchTip reporting for JavaScript and TypeScript: SDK adapters, Telegram relay, and live verification.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className={`${display.variable} ${body.variable} ${mono.variable} bg-void font-body text-ink antialiased`}>
        {children}
      </body>
    </html>
  );
}
