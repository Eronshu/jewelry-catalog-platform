import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import Home, { meta } from "./home";

describe("home route", () => {
  it("renders the scaffold status", () => {
    const markup = renderToStaticMarkup(<Home />);

    expect(markup).toContain("Application scaffold ready");
  });

  it("provides baseline metadata", () => {
    expect(meta({} as never)).toContainEqual({ title: "Jewelry Catalog" });
  });
});
