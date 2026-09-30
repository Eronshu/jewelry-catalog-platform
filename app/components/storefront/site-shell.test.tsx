import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";

import { SiteShell } from "./site-shell";

describe("public site shell", () => {
  it("provides landmarks, a skip link, and only implemented destinations", () => {
    const markup = renderToStaticMarkup(
      <MemoryRouter>
        <SiteShell>
          <h1>Page content</h1>
        </SiteShell>
      </MemoryRouter>,
    );

    expect(markup).toContain('href="#main-content"');
    expect(markup).toContain('<main class="site-main" id="main-content"');
    expect(markup).toContain('aria-label="Primary"');
    expect(markup).toContain('aria-label="Footer"');
    expect(markup).toContain('href="/shop"');
    expect(markup).not.toContain('href="/contact"');
    expect(markup.match(/>Home<\/a>/g)).toHaveLength(2);
  });

  it("starts with mobile navigation collapsed", () => {
    const markup = renderToStaticMarkup(
      <MemoryRouter>
        <SiteShell>Content</SiteShell>
      </MemoryRouter>,
    );

    expect(markup).toContain('aria-controls="mobile-navigation"');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('aria-label="Open menu"');
    expect(markup).toContain('hidden="" id="mobile-navigation"');
  });
});
