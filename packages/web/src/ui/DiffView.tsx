import { t } from "../i18n/index.ts";

export type DiffLine = { kind: "hunk" | "add" | "del" | "ctx"; text: string };
export type DiffFile = { path: string; added: number; removed: number; lines: readonly DiffLine[] };

/** Unified diff per file. Line kind is conveyed by the +/− prefix and a hidden label, not color alone. */
export function DiffView({ files }: { files: readonly DiffFile[] }) {
  return (
    <div className="k-diff">
      {files.map((file) => (
        <section key={file.path} className="k-diff__file" aria-label={file.path}>
          <header className="k-diff__head">
            <span className="k-diff__path">{file.path}</span>
            <span className="k-diff__stat">
              <span className="k-diff__plus">+{file.added}</span>{" "}
              <span className="k-diff__minus">−{file.removed}</span>
            </span>
          </header>
          <pre className="k-diff__body">
            {file.lines.map((line, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: diff lines are static and ordered.
              <span key={index} className={`k-diff__line k-diff__line--${line.kind}`}>
                {line.kind === "add" && (
                  <span className="k-visually-hidden">{t("diff.added")}</span>
                )}
                {line.kind === "del" && (
                  <span className="k-visually-hidden">{t("diff.removed")}</span>
                )}
                {line.text}
                {"\n"}
              </span>
            ))}
          </pre>
        </section>
      ))}
    </div>
  );
}
