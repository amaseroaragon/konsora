/** Konsora's mark and name, shared by the app shell and the mock. */
export function Brand() {
  return (
    <div className="a-header__brand">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <rect x="3" y="3" width="7" height="7" stroke="var(--k-accent)" strokeWidth="1.75" />
        <rect x="14" y="3" width="7" height="7" stroke="var(--k-accent)" strokeWidth="1.75" />
        <rect x="8.5" y="14" width="7" height="7" stroke="var(--k-accent)" strokeWidth="1.75" />
        <path d="M6.5 10v2h11v-2M12 12v2" stroke="var(--k-accent)" strokeWidth="1.75" />
      </svg>
      <span className="a-header__name">KONSORA</span>
    </div>
  );
}
