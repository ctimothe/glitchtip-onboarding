import { createHighlighter, type Highlighter } from "shiki";

let pending: Promise<Highlighter> | null = null;

function getHighlighter(): Promise<Highlighter> {
  pending ??= createHighlighter({
    themes: ["github-dark"],
    langs: ["ts", "tsx", "bash", "json", "python", "diff"],
  });
  return pending;
}

export async function highlight(code: string, lang: string): Promise<string> {
  const highlighter = await getHighlighter();
  return highlighter.codeToHtml(code, { lang, theme: "github-dark" });
}
