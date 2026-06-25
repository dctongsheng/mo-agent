import React, { useMemo } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";

marked.setOptions({ gfm: true, breaks: true });

/** Renders agent reply text as sanitized markdown, styled for chat bubbles. */
export function Markdown({ text }: { text: string }) {
  const html = useMemo(() => {
    const raw = marked.parse(text, { async: false }) as string;
    return DOMPurify.sanitize(raw);
  }, [text]);

  return (
    <>
      <style>{`
        .mo-md { font-size: 14.5px; line-height: 1.7; }
        .mo-md > :first-child { margin-top: 0; }
        .mo-md > :last-child { margin-bottom: 0; }
        .mo-md p { margin: 0.55em 0; }
        .mo-md h1, .mo-md h2, .mo-md h3, .mo-md h4 {
          font-family: 'Noto Serif SC', serif; font-weight: 650;
          margin: 0.9em 0 0.4em; line-height: 1.4;
        }
        .mo-md h1 { font-size: 1.25em; } .mo-md h2 { font-size: 1.15em; }
        .mo-md h3 { font-size: 1.05em; } .mo-md h4 { font-size: 1em; }
        .mo-md ul, .mo-md ol { margin: 0.5em 0; padding-left: 1.5em; }
        .mo-md li { margin: 0.25em 0; }
        .mo-md li > p { margin: 0; }
        .mo-md code {
          font-family: 'JetBrains Mono', monospace; font-size: 0.86em;
          background: var(--bg-2); border: 1px solid var(--line);
          border-radius: 4px; padding: 1px 5px;
        }
        .mo-md pre {
          background: var(--bg-2); border: 1px solid var(--line);
          border-radius: 8px; padding: 12px 14px; overflow-x: auto;
          margin: 0.6em 0;
        }
        .mo-md pre code { background: none; border: none; padding: 0; font-size: 12.5px; line-height: 1.6; }
        .mo-md blockquote {
          margin: 0.6em 0; padding: 2px 0 2px 12px;
          border-left: 3px solid var(--line-2); color: var(--ink-2);
        }
        .mo-md a { color: var(--indigo); text-decoration: underline; text-underline-offset: 2px; }
        .mo-md hr { border: none; border-top: 1px dashed var(--line-2); margin: 0.9em 0; }
        .mo-md table { border-collapse: collapse; margin: 0.6em 0; font-size: 13px; }
        .mo-md th, .mo-md td { border: 1px solid var(--line); padding: 5px 10px; text-align: left; }
        .mo-md th { background: var(--bg-2); font-weight: 600; }
        .mo-md strong { font-weight: 650; }
      `}</style>
      <div
        className="mo-md"
        dangerouslySetInnerHTML={{ __html: html }}
        onClick={(e) => {
          // open links externally instead of navigating the window
          const a = (e.target as HTMLElement).closest("a");
          if (a?.href) {
            e.preventDefault();
            (window as any).moAPI?.openExternal?.(a.href);
          }
        }}
      />
    </>
  );
}
