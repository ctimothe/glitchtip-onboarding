// Telegram's native forum-topic icon colours (the only values the Bot API
// accepts for createForumTopic), in Telegram's own order, with the
// translation key that names each one.

import type { TranslationKey } from "../i18n";

export const TOPIC_COLORS: Array<{ value: number; name: TranslationKey }> = [
  { value: 0x6fb9f0, name: "color.blue" },
  { value: 0xffd67e, name: "color.yellow" },
  { value: 0xcb86db, name: "color.violet" },
  { value: 0x8eee98, name: "color.green" },
  { value: 0xff93b2, name: "color.rose" },
  { value: 0xfb6f5f, name: "color.red" },
];

/** CSS colour for a topic colour value. This is data from Telegram, not a style token. */
export function topicCss(value: number): string {
  return `#${value.toString(16).padStart(6, "0")}`;
}
