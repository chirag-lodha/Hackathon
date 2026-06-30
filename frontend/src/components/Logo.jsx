export default function Logo({ size = 40, withWordmark = true }) {
  return (
    <div className="logo">
      <img className="logo-brivo" src="/brivo-logo-light.svg" alt="Brivo" style={{ height: size * 0.62 }} />
      {withWordmark && (
        <>
          <span className="logo-divider" />
          <span className="logo-lumina">Lumina</span>
        </>
      )}
      <style>{`
        .logo { display: inline-flex; align-items: center; gap: 12px; }
        .logo-brivo { display: block; width: auto; }
        .logo-divider { width: 1px; height: 22px; background: var(--border-strong); }
        .logo-lumina {
          font-weight: 800; font-size: 20px; letter-spacing: -0.4px;
          background: var(--accent-grad); -webkit-background-clip: text; background-clip: text; color: transparent;
        }
      `}</style>
    </div>
  )
}
