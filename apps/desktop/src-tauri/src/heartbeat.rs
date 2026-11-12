//! The inbox's once-a-minute beat.
//!
//! The inbox polls from the window (`src/lib/inbox.ts`), and macOS slows the timers of a window
//! that is hidden or behind others: with the timer in the page, a check due every minute came two
//! minutes apart and later (measured on macOS 27.2, 2026-11-12). An error tracker earns its place in the
//! menu bar while nobody is looking at it, so the beat comes from here instead, as an `inbox-tick`
//! event the window answers with a poll, and the process tells macOS it is doing timed work so
//! that App Nap does not slow this thread too. Idle sleep stays allowed.

use std::time::Duration;

use tauri::{AppHandle, Emitter};

pub const BEAT: Duration = Duration::from_secs(60);

/// Start the beat for the life of the app. The window polls once on its own when it opens.
pub fn start(app: &AppHandle) {
    stay_out_of_app_nap();
    let app = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(BEAT);
        let _ = app.emit("inbox-tick", ());
    });
}

#[cfg(target_os = "macos")]
fn stay_out_of_app_nap() {
    use objc2_foundation::{NSActivityOptions, NSProcessInfo, NSString};

    let activity = NSProcessInfo::processInfo().beginActivityWithOptions_reason(
        NSActivityOptions::UserInitiatedAllowingIdleSystemSleep,
        &NSString::from_str("Watching GlitchTip for new errors"),
    );
    // Held until the process ends.
    std::mem::forget(activity);
}

#[cfg(not(target_os = "macos"))]
fn stay_out_of_app_nap() {}
