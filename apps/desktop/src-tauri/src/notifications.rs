//! Inbox notifications through the system's notification centre (the UserNotifications
//! framework), which the notification plugin does not use on the Mac. It gives each notification
//! Resolve and Ignore buttons, stacks a project's notifications together, shows them while the
//! window is in front, and says which error was clicked.
//!
//! The renderer builds the text in the workspace's language (`src/lib/notify.ts`) and calls
//! `notify_post`. What the user then does is kept here until the window takes it
//! (`inbox_commands_take`, announced by an `inbox-command` event): `open` for a click on the
//! notification, `resolved` or `ignored` for its buttons. The issue's inbox key, bound to the
//! connection it was read over, travels as the notification's identifier, so a later notification
//! about the same error replaces the earlier one, and nothing else about the error is stored with
//! the system.
//!
//! The notification centre only serves a signed app bundle. Outside a bundle (`cargo run`, tests)
//! `notify_post` answers `unavailable`, and for an unsigned build the system refuses and it
//! answers `not-allowed` (seen on macOS 27.2 with the unsigned debug bundle, 2026-11-12: "UNErrorDomain
//! error 1", with no question put to the user). Either way the renderer falls back to the plugin.

use tauri::{AppHandle, Emitter};

/// One notification, as `nativeNotification` in `src/lib/notify.ts` builds it.
#[derive(serde::Deserialize)]
pub struct NativeNotification {
    title: String,
    subtitle: String,
    body: String,
    /// The leading issue's inbox key, `<server id>:<issue id>`.
    key: String,
    /// Notifications of one project stack together.
    thread: String,
    critical: bool,
    /// Resolve and Ignore buttons: only where the notification is about one error.
    actions: bool,
}

/// The buttons' titles, in the workspace's language.
#[derive(serde::Deserialize)]
pub struct ActionLabels {
    resolve: String,
    ignore: String,
}

#[derive(Clone, serde::Serialize)]
pub struct InboxCommand {
    pub command: &'static str,
    pub key: String,
}

const RESOLVE_ACTION: &str = "resolve";
const IGNORE_ACTION: &str = "ignore";
/// The value of `UNNotificationDefaultActionIdentifier`: the notification itself was clicked.
const DEFAULT_ACTION: &str = "com.apple.UNNotificationDefaultActionIdentifier";

/// What a response to a notification asks the inbox to do; nothing for a dismissal.
fn command_for(action: &str) -> Option<&'static str> {
    match action {
        DEFAULT_ACTION => Some("open"),
        RESOLVE_ACTION => Some("resolved"),
        IGNORE_ACTION => Some("ignored"),
        _ => None,
    }
}

/// What the user chose and the window has not taken yet. A notification's button can start the app,
/// and the choice then arrives before the window can listen.
static PENDING: std::sync::Mutex<Vec<InboxCommand>> = std::sync::Mutex::new(Vec::new());

/// Keep what the user chose and tell the window there is something to take; `open` also brings the
/// window forward.
pub fn send_command(app: &AppHandle, command: &'static str, key: String) {
    if command == "open" {
        crate::show_main_window(app);
    }
    if let Ok(mut pending) = PENDING.lock() {
        pending.push(InboxCommand { command, key });
    }
    let _ = app.emit("inbox-command", ());
}

/// Hand the window every choice it has not carried out yet, oldest first.
#[tauri::command]
pub fn inbox_commands_take() -> Vec<InboxCommand> {
    PENDING.lock().map(|mut pending| std::mem::take(&mut *pending)).unwrap_or_default()
}

/// Bring the window forward: a change asked for in a notification failed, and the inbox says why.
#[tauri::command]
pub fn window_show(app: AppHandle) {
    crate::show_main_window(&app);
}

/// Whether this process runs from inside an app bundle, the only place the notification centre works.
fn in_app_bundle() -> bool {
    std::env::current_exe()
        .ok()
        .and_then(|path| path.to_str().map(|p| p.contains(".app/Contents/MacOS/")))
        .unwrap_or(false)
}

#[cfg(target_os = "macos")]
mod centre {
    use std::sync::OnceLock;

    use block2::{DynBlock, RcBlock};
    use objc2::rc::Retained;
    use objc2::runtime::{Bool, ProtocolObject};
    use objc2::{define_class, msg_send, ClassType};
    use objc2_foundation::{NSArray, NSError, NSObject, NSObjectProtocol, NSSet, NSString};
    use objc2_user_notifications::{
        UNAuthorizationOptions, UNMutableNotificationContent, UNNotification, UNNotificationAction,
        UNNotificationActionOptions, UNNotificationCategory, UNNotificationCategoryOptions,
        UNNotificationInterruptionLevel, UNNotificationPresentationOptions, UNNotificationRequest,
        UNNotificationResponse, UNNotificationSound, UNUserNotificationCenter, UNUserNotificationCenterDelegate,
    };
    use tauri::AppHandle;

    use super::{command_for, send_command, ActionLabels, NativeNotification, IGNORE_ACTION, RESOLVE_ACTION};

    /// One error, with Resolve and Ignore; several errors, without.
    const CATEGORY: &str = "issue";
    const CATEGORY_GROUP: &str = "issues";

    static APP: OnceLock<AppHandle> = OnceLock::new();

    define_class!(
        // SAFETY: NSObject has no subclassing requirements, and the class has no state and no Drop.
        #[unsafe(super(NSObject))]
        #[name = "CompanionNotificationDelegate"]
        struct Delegate;

        unsafe impl NSObjectProtocol for Delegate {}

        unsafe impl UNUserNotificationCenterDelegate for Delegate {
            // Without this the system shows nothing while the app is in front.
            #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
            fn will_present(
                &self,
                _center: &UNUserNotificationCenter,
                _notification: &UNNotification,
                completion: &DynBlock<dyn Fn(UNNotificationPresentationOptions)>,
            ) {
                completion.call((UNNotificationPresentationOptions::Banner
                    | UNNotificationPresentationOptions::List
                    | UNNotificationPresentationOptions::Sound,));
            }

            #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
            fn did_receive(
                &self,
                _center: &UNUserNotificationCenter,
                response: &UNNotificationResponse,
                completion: &DynBlock<dyn Fn()>,
            ) {
                let action = response.actionIdentifier().to_string();
                let key = response.notification().request().identifier().to_string();
                if let (Some(command), Some(app)) = (command_for(&action), APP.get()) {
                    send_command(app, command, key);
                }
                completion.call(());
            }
        }
    );

    /// Take the centre's delegate role, so clicks reach the window. Call once, at launch.
    pub fn install(app: &AppHandle) {
        if APP.set(app.clone()).is_err() {
            return;
        }
        // SAFETY: `new` on an NSObject subclass without instance variables.
        let delegate: Retained<Delegate> = unsafe { msg_send![Delegate::class(), new] };
        UNUserNotificationCenter::currentNotificationCenter().setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
        // The centre holds its delegate weakly; this one lives as long as the app.
        std::mem::forget(delegate);
    }

    /// Ask for permission and report the answer. The system asks the user the first time and
    /// remembers; it refuses at once, without asking, for an app that carries no signature.
    pub fn authorize() -> std::sync::mpsc::Receiver<bool> {
        let (tx, rx) = std::sync::mpsc::channel::<bool>();
        let answered = RcBlock::new(move |granted: Bool, error: *mut NSError| {
            if cfg!(debug_assertions) && !granted.as_bool() {
                // SAFETY: the system passes a valid error or null.
                let reason = unsafe { error.as_ref() }.map(|e| e.localizedDescription().to_string());
                eprintln!("notifications: not allowed ({})", reason.unwrap_or_else(|| "the user declined".into()));
            }
            let _ = tx.send(granted.as_bool());
        });
        UNUserNotificationCenter::currentNotificationCenter().requestAuthorizationWithOptions_completionHandler(
            UNAuthorizationOptions::Alert | UNAuthorizationOptions::Sound | UNAuthorizationOptions::Badge,
            &answered,
        );
        rx
    }

    pub fn post(notifications: &[NativeNotification], labels: &ActionLabels) {
        let centre = UNUserNotificationCenter::currentNotificationCenter();
        let none = UNNotificationActionOptions::empty();
        let actions = NSArray::from_retained_slice(&[
            UNNotificationAction::actionWithIdentifier_title_options(
                &NSString::from_str(RESOLVE_ACTION),
                &NSString::from_str(&labels.resolve),
                none,
            ),
            UNNotificationAction::actionWithIdentifier_title_options(
                &NSString::from_str(IGNORE_ACTION),
                &NSString::from_str(&labels.ignore),
                none,
            ),
        ]);
        let category = UNNotificationCategory::categoryWithIdentifier_actions_intentIdentifiers_options(
            &NSString::from_str(CATEGORY),
            &actions,
            &NSArray::new(),
            UNNotificationCategoryOptions::empty(),
        );
        let group = UNNotificationCategory::categoryWithIdentifier_actions_intentIdentifiers_options(
            &NSString::from_str(CATEGORY_GROUP),
            &NSArray::new(),
            &NSArray::new(),
            UNNotificationCategoryOptions::empty(),
        );
        centre.setNotificationCategories(&NSSet::from_retained_slice(&[category, group]));

        for notification in notifications {
            let content = UNMutableNotificationContent::new();
            content.setTitle(&NSString::from_str(&notification.title));
            content.setSubtitle(&NSString::from_str(&notification.subtitle));
            content.setBody(&NSString::from_str(&notification.body));
            content.setThreadIdentifier(&NSString::from_str(&notification.thread));
            content.setCategoryIdentifier(&NSString::from_str(if notification.actions { CATEGORY } else { CATEGORY_GROUP }));
            content.setSound(Some(&UNNotificationSound::defaultSound()));
            // Time-sensitive needs an entitlement only a signed release carries; without it the
            // system treats the notification as an ordinary one.
            content.setInterruptionLevel(if notification.critical {
                UNNotificationInterruptionLevel::TimeSensitive
            } else {
                UNNotificationInterruptionLevel::Active
            });
            let request = UNNotificationRequest::requestWithIdentifier_content_trigger(
                &NSString::from_str(&notification.key),
                &content,
                None,
            );
            let key = notification.key.clone();
            let added = RcBlock::new(move |error: *mut NSError| {
                if cfg!(debug_assertions) {
                    // SAFETY: the system passes a valid error or null.
                    match unsafe { error.as_ref() } {
                        Some(e) => eprintln!("notifications: {key} was refused ({})", e.localizedDescription()),
                        None => eprintln!("notifications: posted {key}"),
                    }
                }
            });
            centre.addNotificationRequest_withCompletionHandler(&request, Some(&added));
        }
    }
}

/// Take the notification centre's delegate role at launch; does nothing outside an app bundle.
pub fn install(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    if in_app_bundle() {
        centre::install(app);
    }
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

/// How long to wait for the user's answer to the system's first "allow notifications?" question.
const ANSWER_WITHIN: std::time::Duration = std::time::Duration::from_secs(20);

/// Post the inbox's notifications. `unavailable` (not an app bundle) and `not-allowed` (the system
/// refused: the user said no, has not answered yet, or the build is unsigned) tell the renderer to
/// fall back to the plugin.
#[tauri::command]
pub async fn notify_post(notifications: Vec<NativeNotification>, actions: ActionLabels) -> Result<(), String> {
    if !in_app_bundle() {
        return Err("unavailable".into());
    }
    #[cfg(target_os = "macos")]
    {
        // The first question can sit unanswered for hours. Nothing is held for it: this alert goes
        // out through the plugin, and later ones come here again.
        let answer = centre::authorize();
        let allowed = tauri::async_runtime::spawn_blocking(move || answer.recv_timeout(ANSWER_WITHIN).unwrap_or(false)).await;
        if !matches!(allowed, Ok(true)) {
            return Err("not-allowed".into());
        }
        centre::post(&notifications, &actions);
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (notifications, actions);
        Err("unavailable".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_click_opens_and_the_buttons_change_the_error() {
        assert_eq!(command_for(DEFAULT_ACTION), Some("open"));
        assert_eq!(command_for(RESOLVE_ACTION), Some("resolved"));
        assert_eq!(command_for(IGNORE_ACTION), Some("ignored"));
    }

    #[test]
    fn a_dismissal_or_an_unknown_action_does_nothing() {
        assert_eq!(command_for("com.apple.UNNotificationDismissActionIdentifier"), None);
        assert_eq!(command_for(""), None);
    }

    #[test]
    fn the_test_binary_is_not_an_app_bundle() {
        assert!(!in_app_bundle());
    }

    #[test]
    fn a_command_carries_the_issue_key_as_the_window_expects() {
        let json = serde_json::to_value(InboxCommand { command: "open", key: "primary:42".into() }).unwrap();
        assert_eq!(json, serde_json::json!({ "command": "open", "key": "primary:42" }));
    }

    #[test]
    fn choices_wait_until_the_window_takes_them_once_and_in_order() {
        PENDING.lock().unwrap().clear();
        PENDING.lock().unwrap().push(InboxCommand { command: "resolved", key: "primary:1@t".into() });
        PENDING.lock().unwrap().push(InboxCommand { command: "open", key: "primary:2".into() });
        let taken = inbox_commands_take();
        assert_eq!(taken.iter().map(|c| (c.command, c.key.as_str())).collect::<Vec<_>>(), vec![("resolved", "primary:1@t"), ("open", "primary:2")]);
        assert!(inbox_commands_take().is_empty());
    }
}
