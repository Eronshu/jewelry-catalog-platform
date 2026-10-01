import { RouterContextProvider } from "react-router";
import { describe, expect, it } from "vitest";

import { readAdminForm } from "./admin-mutation.server";
import {
  loader as listLoader,
  action as listAction,
} from "../../routes/admin-products";
import {
  loader as newLoader,
  action as newAction,
} from "../../routes/admin-product-new";
import {
  loader as editLoader,
  action as editAction,
} from "../../routes/admin-product-edit";

function request(origin?: string, body = "intent=save&name=Demo") {
  return new Request("https://catalog.example/admin/products/new", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      ...(origin ? { Origin: origin } : {}),
    },
    body,
  });
}

describe("admin mutation boundary", () => {
  it("accepts a normal same-origin form and rejects cross-site or missing origins", async () => {
    const form = await readAdminForm(request("https://catalog.example"));
    expect(form.get("name")).toBe("Demo");
    await expect(
      readAdminForm(request("https://other.example")),
    ).rejects.toMatchObject({ status: 403 });
    await expect(readAdminForm(request())).rejects.toMatchObject({
      status: 403,
    });
  });

  it("rejects oversized and unexpected mutation bodies", async () => {
    await expect(
      readAdminForm(
        request("https://catalog.example", `description=${"a".repeat(33_000)}`),
      ),
    ).rejects.toMatchObject({ status: 413 });
    await expect(
      readAdminForm(
        new Request("https://catalog.example/admin/products", {
          method: "POST",
          headers: {
            Origin: "https://catalog.example",
            "Content-Type": "application/json",
          },
          body: "{}",
        }),
      ),
    ).rejects.toMatchObject({ status: 415 });
  });

  it("requires a trusted principal in every product loader and action", async () => {
    const context = new RouterContextProvider();
    const args = {
      context,
      request: request("https://catalog.example"),
      params: { productId: "1" },
    };
    for (const run of [
      listLoader,
      listAction,
      newLoader,
      newAction,
      editLoader,
      editAction,
    ] as Array<(args: never) => unknown>) {
      await expect(
        Promise.resolve().then(() => run(args as never)),
      ).rejects.toMatchObject({ status: 401 });
    }
  });
});
