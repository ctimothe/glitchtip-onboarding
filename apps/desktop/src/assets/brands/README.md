# Brand marks

The four `.svg` files here are the vendors' own marks, downloaded on 2026-10-28 from the sources
below and committed byte for byte (the SHA-256 is of the committed file). Each was checked to hold
vector shapes only: no scripts, event handlers, links, embedded images or remote URLs.

Production code imports these local files only (`ServiceMark`); tests reject http(s) sources.
Do not recolour, crop or redraw a mark. The OpenAI Blossom is black in the file; `ServiceMark`
inverts it to white in dark mode (`--filter-mark-mono`), which matches OpenAI's own white variant
in the same package.

| File | Official source | Original file | Licence / trademark note | SHA-256 |
|---|---|---|---|---|
| glitchtip.svg | GlitchTip frontend repository, https://gitlab.com/glitchtip/glitchtip-frontend/-/raw/master/src/assets/images/glitchtip-logo-collasped.svg | `glitchtip-logo-collasped.svg` (the mark without the wordmark) | GlitchTip is MIT-licensed software; the logo ships in its frontend repository | `bd0840c8f5a4db254e43421f1eefd3cae6cb069daf50d7872533c1a3d9a447ff` |
| telegram.svg | telegram.org, https://telegram.org/img/t_logo.svg | `t_logo.svg` | Telegram trademark; follow Telegram's brand guidelines | `85059d5e5bf7bda91ebab30664993c49867a26be6b947834aca16c846581766a` |
| openai.svg | OpenAI brand guidelines, https://openai.com/brand ("Download logos": https://cdn.openai.com/brand/openai-logos.zip, SHA-256 of the zip `c54e85ab5884228f89f0230dd8effa8d588cad78166fe954135f4afa553222db`) | `OpenAI-logos/SVGs/OAI_OpenAI-Blossom_Black.svg` | OpenAI trademark; use only next to the OpenAI service it names (here: the Codex agent), never as this app's branding, never altered | `75c1e9fffa5e8c437bec1d67197a73992bca45d166c6ff23215185dea8fae92a` |
| anthropic.svg | Anthropic press kit, https://www.anthropic.com/press-kit (zip SHA-256 `c68ac92df86c825f95177e24016fcc9a8863a3fd4ca344fe6f0700b2c1e07151`) | `Anthropic logos/Claude logos/3 Claude Spark/SVG/Claude Spark - Clay.svg` | Anthropic trademark; use only next to Claude (here: the Claude Code agent), never altered | `6d53db4be375e899c937c26cf16684a80d6e869b1928d72b37748bef2560e219` |
