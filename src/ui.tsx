import type { ReactNode } from "react";

export function Panel({
  title,
  actions,
  children,
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="panel">
      {(title || actions) && (
        <header className="panel-head">
          <span className="panel-title">{title}</span>
          <span className="panel-actions">{actions}</span>
        </header>
      )}
      <div className="panel-body">{children}</div>
    </section>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="field">
      <span className="field-label">
        {label}
        {hint && <em className="field-hint">{hint}</em>}
      </span>
      {children}
    </label>
  );
}

export function Badge({
  tone = "none",
  children,
}: {
  tone?: "high" | "mid" | "low" | "none" | "ok" | "warn";
  children: ReactNode;
}) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function ErrorBar({ text, onClose }: { text: string; onClose?: () => void }) {
  return (
    <div className="errorbar" role="alert">
      <span>{text}</span>
      {onClose && (
        <button className="icon-btn" onClick={onClose} title="关闭">
          ×
        </button>
      )}
    </div>
  );
}

export function Notice({ tone = "info", children }: { tone?: "info" | "warn"; children: ReactNode }) {
  return <div className={`notice notice-${tone}`}>{children}</div>;
}

export function Spinner() {
  return <span className="spinner" aria-hidden="true" />;
}
