import { useEffect, useRef, useState } from "react";
import { Link, NavLink, useLocation } from "react-router";

// Keep this aligned with the desktop navigation media query in app.css.
const desktopNavigationQuery = "(min-width: 64rem)";

function PrimaryLinks({
  onNavigate,
}: {
  onNavigate?: (destination: "/" | "/shop") => void;
}) {
  return (
    <>
      <NavLink
        className="nav-link"
        end
        onClick={() => onNavigate?.("/")}
        to="/"
      >
        Home
      </NavLink>
      <NavLink
        className="nav-link"
        onClick={() => onNavigate?.("/shop")}
        to="/shop"
      >
        Shop
      </NavLink>
    </>
  );
}

function SiteHeader() {
  const { pathname } = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const focusTriggerAfterClose = useRef(false);

  useEffect(() => {
    if (menuOpen || !focusTriggerAfterClose.current) return;

    focusTriggerAfterClose.current = false;
    menuButton.current?.focus();
  }, [menuOpen]);

  function handleMobileNavigate(destination: "/" | "/shop") {
    focusTriggerAfterClose.current = destination === pathname;
    setMenuOpen(false);
  }

  useEffect(() => {
    if (!menuOpen) return;

    function dismissOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setMenuOpen(false);
        menuButton.current?.focus();
      }
    }

    document.addEventListener("keydown", dismissOnEscape);
    return () => document.removeEventListener("keydown", dismissOnEscape);
  }, [menuOpen]);

  useEffect(() => {
    const desktopNavigation = window.matchMedia(desktopNavigationQuery);

    function closeMenuOnDesktop(event: MediaQueryListEvent) {
      if (event.matches) setMenuOpen(false);
    }

    desktopNavigation.addEventListener("change", closeMenuOnDesktop);
    return () =>
      desktopNavigation.removeEventListener("change", closeMenuOnDesktop);
  }, []);

  return (
    <header className="site-header">
      <div className="container header-inner">
        <Link className="wordmark" to="/" onClick={() => setMenuOpen(false)}>
          Velaform Studio
        </Link>
        <nav aria-label="Primary" className="desktop-nav">
          <PrimaryLinks />
        </nav>
        <button
          aria-controls="mobile-navigation"
          aria-expanded={menuOpen}
          aria-label={menuOpen ? "Close menu" : "Open menu"}
          className="menu-trigger"
          onClick={() => setMenuOpen((open) => !open)}
          ref={menuButton}
          type="button"
        >
          <span aria-hidden="true" className="menu-icon" />
          Menu
        </button>
      </div>
      <nav
        aria-label="Mobile primary"
        className="mobile-nav"
        hidden={!menuOpen}
        id="mobile-navigation"
      >
        <div className="container mobile-nav-inner">
          <PrimaryLinks onNavigate={handleMobileNavigate} />
        </div>
      </nav>
    </header>
  );
}

export function SiteShell({ children }: { children: React.ReactNode }) {
  const { pathname } = useLocation();
  const previousPathname = useRef(pathname);

  useEffect(() => {
    if (previousPathname.current === pathname) return;

    previousPathname.current = pathname;
    document.getElementById("main-content")?.focus();
  }, [pathname]);

  return (
    <div className="site-shell">
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <SiteHeader />
      <main className="site-main" id="main-content" tabIndex={-1}>
        {children}
      </main>
      <footer className="site-footer">
        <div className="container footer-inner">
          <p className="footer-note">
            Velaform Studio <span aria-hidden="true">·</span> Fictional
            portfolio demo
          </p>
          <nav aria-label="Footer" className="footer-nav">
            <Link to="/shop">Shop</Link>
          </nav>
        </div>
      </footer>
    </div>
  );
}
