// The macOS menu bar. Like the tray menu, it is built here from labels the renderer sends
// (`src/app/menu.ts`, which owns the translations), and a chosen item of ours reaches the renderer
// as an `app-menu` event carrying the item's command: a sidebar destination, `settings` or
// `add-application`. Everything else is AppKit's own (Hide, Copy, Minimize, …).

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Runtime};

/// Ids of our own items carry this prefix; the rest of the id is the command.
const PREFIX: &str = "app-menu:";
/// The renderer listens for this event.
pub const EVENT: &str = "app-menu";

/// A sidebar destination, in sidebar order: the n-th gets ⌘n.
#[derive(serde::Deserialize, Clone)]
pub struct Destination {
    pub id: String,
    pub text: String,
}

#[derive(serde::Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AppMenuLabels {
    pub app: String,
    pub about: String,
    pub settings: String,
    pub services: String,
    pub hide: String,
    pub hide_others: String,
    pub show_all: String,
    pub quit: String,
    pub file: String,
    pub add_application: String,
    pub close_window: String,
    pub edit: String,
    pub undo: String,
    pub redo: String,
    pub cut: String,
    pub copy: String,
    pub paste: String,
    pub select_all: String,
    pub view: String,
    pub full_screen: String,
    pub window: String,
    pub minimize: String,
    pub zoom: String,
    pub help: String,
    pub destinations: Vec<Destination>,
}

impl Default for AppMenuLabels {
    /// English, with no destinations, until the renderer sends its labels.
    fn default() -> Self {
        let text = |s: &str| s.to_string();
        Self {
            app: text("GlitchTip Companion"),
            about: text("About GlitchTip Companion"),
            settings: text("Settings…"),
            services: text("Services"),
            hide: text("Hide GlitchTip Companion"),
            hide_others: text("Hide Others"),
            show_all: text("Show All"),
            quit: text("Quit GlitchTip Companion"),
            file: text("File"),
            add_application: text("Add Application…"),
            close_window: text("Close Window"),
            edit: text("Edit"),
            undo: text("Undo"),
            redo: text("Redo"),
            cut: text("Cut"),
            copy: text("Copy"),
            paste: text("Paste"),
            select_all: text("Select All"),
            view: text("View"),
            full_screen: text("Enter Full Screen"),
            window: text("Window"),
            minimize: text("Minimize"),
            zoom: text("Zoom"),
            help: text("Help"),
            destinations: Vec::new(),
        }
    }
}

/// The command an item id names, when the item is one of ours.
pub fn command_of(id: &str) -> Option<&str> {
    id.strip_prefix(PREFIX).filter(|command| !command.is_empty())
}

/// ⌘1…⌘9 for the first nine destinations.
fn destination_shortcut(index: usize) -> Option<String> {
    (index < 9).then(|| format!("CmdOrCtrl+{}", index + 1))
}

/// `navigation` is false until setup is done: the app's own commands are then shown but disabled.
pub fn build<R: Runtime>(app: &AppHandle<R>, labels: &AppMenuLabels, navigation: bool) -> tauri::Result<Menu<R>> {
    let item = |command: &str, text: &str, shortcut: Option<&str>| {
        MenuItem::with_id(app, format!("{PREFIX}{command}"), text, navigation, shortcut)
    };
    let separator = || PredefinedMenuItem::separator(app);

    let app_menu = Submenu::with_items(
        app,
        &labels.app,
        true,
        &[
            &PredefinedMenuItem::about(app, Some(labels.about.as_str()), None)?,
            &separator()?,
            &item("settings", &labels.settings, Some("CmdOrCtrl+,"))?,
            &separator()?,
            &PredefinedMenuItem::services(app, Some(labels.services.as_str()))?,
            &separator()?,
            &PredefinedMenuItem::hide(app, Some(labels.hide.as_str()))?,
            &PredefinedMenuItem::hide_others(app, Some(labels.hide_others.as_str()))?,
            &PredefinedMenuItem::show_all(app, Some(labels.show_all.as_str()))?,
            &separator()?,
            &PredefinedMenuItem::quit(app, Some(labels.quit.as_str()))?,
        ],
    )?;
    let file = Submenu::with_items(
        app,
        &labels.file,
        true,
        &[
            &item("add-application", &labels.add_application, Some("CmdOrCtrl+N"))?,
            &separator()?,
            &PredefinedMenuItem::close_window(app, Some(labels.close_window.as_str()))?,
        ],
    )?;
    let edit = Submenu::with_items(
        app,
        &labels.edit,
        true,
        &[
            &PredefinedMenuItem::undo(app, Some(labels.undo.as_str()))?,
            &PredefinedMenuItem::redo(app, Some(labels.redo.as_str()))?,
            &separator()?,
            &PredefinedMenuItem::cut(app, Some(labels.cut.as_str()))?,
            &PredefinedMenuItem::copy(app, Some(labels.copy.as_str()))?,
            &PredefinedMenuItem::paste(app, Some(labels.paste.as_str()))?,
            &PredefinedMenuItem::select_all(app, Some(labels.select_all.as_str()))?,
        ],
    )?;
    let view = Submenu::new(app, &labels.view, true)?;
    for (index, destination) in labels.destinations.iter().enumerate() {
        view.append(&item(&destination.id, &destination.text, destination_shortcut(index).as_deref())?)?;
    }
    if !labels.destinations.is_empty() {
        view.append(&separator()?)?;
    }
    view.append(&PredefinedMenuItem::fullscreen(app, Some(labels.full_screen.as_str()))?)?;
    let window = Submenu::with_items(
        app,
        &labels.window,
        true,
        &[
            &PredefinedMenuItem::minimize(app, Some(labels.minimize.as_str()))?,
            &PredefinedMenuItem::maximize(app, Some(labels.zoom.as_str()))?,
        ],
    )?;
    let help = Submenu::new(app, &labels.help, true)?;
    // AppKit then lists the open windows under Window and puts its search field under Help.
    #[cfg(target_os = "macos")]
    {
        window.set_as_windows_menu_for_nsapp()?;
        help.set_as_help_menu_for_nsapp()?;
    }
    Menu::with_items(app, &[&app_menu, &file, &edit, &view, &window, &help])
}

/// Hands one of our items to the renderer; AppKit handles the rest itself.
pub fn on_event<R: Runtime>(app: &AppHandle<R>, id: &str) {
    if let Some(command) = command_of(id) {
        let _ = app.emit(EVENT, command);
    }
}

/// Rebuilds the menu bar in the workspace's language.
#[tauri::command]
pub fn app_menu_update(app: AppHandle, labels: AppMenuLabels, navigation: bool) -> Result<(), String> {
    let menu = build(&app, &labels, navigation).map_err(|e| format!("Could not build the menu bar — {e}."))?;
    app.set_menu(menu).map_err(|e| format!("Could not update the menu bar — {e}."))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_our_items_name_a_command() {
        assert_eq!(command_of("app-menu:settings"), Some("settings"));
        assert_eq!(command_of("app-menu:relay"), Some("relay"));
        assert_eq!(command_of("app-menu:"), None);
        assert_eq!(command_of("tray-open"), None);
    }

    #[test]
    fn the_first_nine_destinations_get_command_digits() {
        assert_eq!(destination_shortcut(0).as_deref(), Some("CmdOrCtrl+1"));
        assert_eq!(destination_shortcut(8).as_deref(), Some("CmdOrCtrl+9"));
        assert_eq!(destination_shortcut(9), None);
    }

    #[test]
    fn labels_arrive_in_the_renderers_shape() {
        // The keys `src/app/menu.ts` sends.
        let keys = [
            "app", "about", "settings", "services", "hide", "hideOthers", "showAll", "quit", "file",
            "addApplication", "closeWindow", "edit", "undo", "redo", "cut", "copy", "paste", "selectAll",
            "view", "fullScreen", "window", "minimize", "zoom", "help",
        ];
        let mut value: serde_json::Map<String, serde_json::Value> =
            keys.iter().map(|key| (key.to_string(), serde_json::json!(key))).collect();
        value.insert("destinations".into(), serde_json::json!([{ "id": "overview", "text": "Обзор" }]));
        let labels: AppMenuLabels = serde_json::from_value(value.into()).unwrap();
        assert_eq!(labels.hide_others, "hideOthers");
        assert_eq!(labels.add_application, "addApplication");
        assert_eq!(labels.destinations[0].text, "Обзор");
    }
}
