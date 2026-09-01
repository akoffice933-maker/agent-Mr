"use client";

import { useEffect } from "react";
import { track } from "@/lib/analytics";

/** Единственная гидратируемая точка /welcome помимо TrackedLink — сам рендер остаётся серверным/ISR. */
export function LandingViewTracker() {
  useEffect(() => {
    track("landing_view");
  }, []);
  return null;
}
