import {
  captureRequestError,
  reportNextError,
  withRouteErrorCapture,
} from "@glitchtip-onboarding/sdk/next";
import type { Reporter } from "@glitchtip-onboarding/sdk/node";

declare const reporter: Reporter;

captureRequestError(reporter, new Error("fixture"), {
  method: "GET",
  path: "/fixture",
});
reportNextError(reporter, new Error("render fixture"));

export const GET = withRouteErrorCapture(reporter, async (_request: Request) => {
  return Response.json({ ok: true });
});
