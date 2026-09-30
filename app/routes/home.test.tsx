import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";

import Home, { meta } from "./home";

describe("home route", () => {
  it("renders an image-led home preview with a working shop destination", () => {
    const markup = renderToStaticMarkup(
      <MemoryRouter>
        <Home />
      </MemoryRouter>,
    );

    expect(markup).toContain('id="home-title"');
    expect(markup).toContain("Wear it your way.");
    expect(markup).toContain('href="/shop"');
    expect(markup).toContain('class="cover-image home-stage-image"');
    expect(markup).not.toContain("home-stage-side");
    expect(markup).toContain("Featured preview");
    expect(markup.match(/class="shop-product-card"/g)).toHaveLength(8);
    expect(markup).toContain("Design-review only · not for sale");
    expect(markup).not.toContain('href="/products/');
    expect(markup).toContain("Shop by mood");
    expect(markup).toContain("Not here to blend in.");
    expect(markup).toContain("images.unsplash.com");
    expect(markup).not.toContain("Photography to follow");
    expect(markup).not.toContain("Application scaffold ready");
  });

  it("provides baseline metadata", () => {
    expect(meta()).toContainEqual({
      title: "Wear it your way | Jewelry Catalog",
    });
  });
});
