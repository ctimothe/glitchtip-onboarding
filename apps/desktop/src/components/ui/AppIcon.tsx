import appIcon from "../../assets/app-icon.png";

// The app's own icon, rendered from src-tauri/icons/icon.svg by `tauri icon`.
// The file keeps the macOS grid's clear space and shadow, so it sits at the
// same optical size as icons in Finder and the Dock. Always shown beside the
// app's name, so it is hidden from assistive tech.
export function AppIcon({ size = 34 }: { size?: number }) {
  return <img className="ui-mark" src={appIcon} alt="" aria-hidden width={size} height={size} />;
}
