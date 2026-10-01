import { useEffect, useRef, useState } from "react";
import {
  Form,
  Link,
  useBeforeUnload,
  useBlocker,
  useNavigation,
} from "react-router";

import type { Category, ProductStatus } from "../../lib/db/catalog-types";
import type {
  FieldErrors,
  ProductFields,
} from "../../lib/db/admin-products.server";

export type FormFeedback =
  | {
      error?: string;
      fieldErrors?: FieldErrors;
      fields?: ProductFields;
      requestKey?: string;
      version?: number;
    }
  | undefined;

const emptyFields: ProductFields = {
  name: "",
  price: "",
  categoryId: "",
  material: "",
  colour: "",
  description: "",
  sku: "",
  quantity: "",
  facebookUrl: "",
};

export function ProductForm({
  categories,
  initial,
  feedback,
  version,
  status,
  requestKey,
  photoCount = 0,
}: {
  categories: Category[];
  initial?: ProductFields;
  feedback?: FormFeedback;
  version?: number;
  status?: ProductStatus;
  requestKey?: string;
  photoCount?: number;
}) {
  const [dirty, setDirty] = useState(false);
  const submittingThisForm = useRef(false);
  const navigation = useNavigation();
  const pending = navigation.state === "submitting";
  const shouldWarn = dirty || Boolean(feedback?.error);
  const blocker = useBlocker(
    () => shouldWarn && !pending && !submittingThisForm.current,
  );
  useEffect(() => {
    if (feedback?.error) submittingThisForm.current = false;
  }, [feedback]);
  useEffect(() => {
    if (blocker.state === "blocked") {
      if (window.confirm("Leave without saving your changes?"))
        blocker.proceed();
      else blocker.reset();
    }
  }, [blocker]);
  useBeforeUnload((event) => {
    if (shouldWarn && !pending && !submittingThisForm.current) {
      event.preventDefault();
      event.returnValue = "";
    }
  });
  const values = feedback?.fields ?? initial ?? emptyFields;
  const errors = feedback?.fieldErrors ?? {};
  const archived = status === "archived";
  const publicationUnavailable =
    (status === "draft" || status === "hidden") && photoCount === 0;
  const field = (
    key: keyof ProductFields,
    label: string,
    options?: { type?: string; multiline?: boolean; required?: boolean },
  ) => (
    <label className="admin-field">
      <span className="admin-field-label">
        {label}
        {options?.required && <small>Required</small>}
      </span>
      {options?.multiline ? (
        <textarea
          name={key}
          defaultValue={values[key]}
          disabled={archived}
          rows={5}
          aria-invalid={Boolean(errors[key])}
          aria-required={options.required}
          aria-describedby={errors[key] ? `${key}-error` : undefined}
        />
      ) : (
        <input
          name={key}
          type={options?.type ?? "text"}
          defaultValue={values[key]}
          disabled={archived}
          aria-invalid={Boolean(errors[key])}
          aria-required={options?.required}
          aria-describedby={errors[key] ? `${key}-error` : undefined}
        />
      )}
      {errors[key] && (
        <small className="admin-field-error" id={`${key}-error`}>
          {errors[key]}
        </small>
      )}
    </label>
  );
  return (
    <>
      {feedback?.error && (
        <div className="admin-alert admin-product-feedback" role="alert">
          {feedback.error}
        </div>
      )}
      {archived && (
        <p className="admin-note">
          This product is archived. Restore it to Draft before editing.
        </p>
      )}
      <Form
        method="post"
        className="admin-product-form"
        onChange={() => setDirty(true)}
        onSubmit={(event) => {
          const submitter = (event.nativeEvent as SubmitEvent)
            .submitter as HTMLButtonElement | null;
          if (
            submitter?.value === "archive" &&
            !window.confirm(
              "Archive this product? It will move out of the normal product list.",
            )
          ) {
            submittingThisForm.current = false;
            event.preventDefault();
          } else {
            submittingThisForm.current = true;
            setDirty(false);
          }
        }}
      >
        {version !== undefined && (
          <input type="hidden" name="version" value={version} />
        )}
        {requestKey && (
          <input type="hidden" name="requestKey" value={requestKey} />
        )}
        <div className="admin-form-intro">
          <p className="admin-form-kicker">Product information</p>
          <h2>{version === undefined ? "Create a product" : "Edit product"}</h2>
          <p>Start with the details customers need to recognize your piece.</p>
        </div>
        <section
          className="admin-form-section"
          aria-labelledby="essentials-title"
        >
          <div className="admin-form-section-heading">
            <div>
              <h3 id="essentials-title">Essentials</h3>
              <p>These three fields are required to save.</p>
            </div>
          </div>
          <div className="admin-form-grid admin-form-grid-essential">
            {field("name", "Product name", { required: true })}
            {field("price", "Price (CAD)", {
              type: "text",
              required: true,
            })}
            <label className="admin-field">
              <span className="admin-field-label">
                Category <small>Required</small>
              </span>
              <select
                name="categoryId"
                defaultValue={values.categoryId}
                disabled={archived}
                aria-invalid={Boolean(errors.categoryId)}
                aria-required="true"
                aria-describedby={
                  errors.categoryId ? "categoryId-error" : undefined
                }
              >
                <option value="">Choose a category</option>
                {categories.map((category) => (
                  <option key={category.id} value={category.id}>
                    {category.name}
                    {!category.isActive ? " (inactive)" : ""}
                  </option>
                ))}
              </select>
              {errors.categoryId && (
                <small className="admin-field-error" id="categoryId-error">
                  {errors.categoryId}
                </small>
              )}
            </label>
          </div>
        </section>
        <section className="admin-form-section" aria-labelledby="more-title">
          <div className="admin-form-section-heading">
            <div>
              <h3 id="more-title">Additional details</h3>
              <p>Add these when they help describe or track the piece.</p>
            </div>
            <span className="admin-optional-tag">Optional</span>
          </div>
          <div className="admin-form-grid">
            {field("material", "Material")}
            {field("colour", "Colour")}
            {field("sku", "SKU")}
            {field("quantity", "Quantity", { type: "text" })}
            <div className="admin-form-grid-wide">
              {field("facebookUrl", "Facebook Marketplace URL", {
                type: "url",
              })}
            </div>
            <div className="admin-form-grid-wide">
              {field("description", "Description", { multiline: true })}
            </div>
          </div>
        </section>
        <div className="admin-form-footer">
          {version === undefined && (
            <p className="admin-form-draft-note">
              <strong>Save as Draft</strong>
              <span>
                This product stays off the website. Add a photo before
                publishing; photo management is coming later.
              </span>
            </p>
          )}
          {publicationUnavailable && (
            <p className="admin-note">
              Add a photo before showing this product. Photo management is
              coming later.
            </p>
          )}
          <div className="admin-form-actions">
            {archived ? (
              <button
                className="admin-save-button"
                type="submit"
                name="intent"
                value="restore"
                disabled={pending}
              >
                Restore to Draft
              </button>
            ) : (
              <>
                <button
                  className="admin-save-button"
                  type="submit"
                  name="intent"
                  value={version === undefined ? "create" : "save"}
                  disabled={pending}
                >
                  {pending ? "Saving…" : "Save"}
                </button>
                {version !== undefined && (
                  <>
                    {status === "draft" && (
                      <button
                        type="submit"
                        name="intent"
                        value="publish"
                        disabled={pending || publicationUnavailable}
                      >
                        Publish
                      </button>
                    )}
                    {status !== "sold" && (
                      <button
                        type="submit"
                        name="intent"
                        value="mark-sold"
                        disabled={pending || publicationUnavailable}
                      >
                        {status === "hidden" ? "Show Sold" : "Mark Sold"}
                      </button>
                    )}
                    {(status === "sold" || status === "hidden") && (
                      <button
                        type="submit"
                        name="intent"
                        value="mark-available"
                        disabled={pending || publicationUnavailable}
                      >
                        {status === "hidden"
                          ? "Show Available"
                          : "Mark Available"}
                      </button>
                    )}
                    {status !== "hidden" && (
                      <button
                        type="submit"
                        name="intent"
                        value="hide"
                        disabled={pending}
                      >
                        Hide
                      </button>
                    )}
                    {status !== "draft" && (
                      <button
                        type="submit"
                        name="intent"
                        value="draft"
                        disabled={pending}
                      >
                        Move to Draft
                      </button>
                    )}
                    <button
                      type="submit"
                      name="intent"
                      value="archive"
                      disabled={pending}
                    >
                      Archive
                    </button>
                  </>
                )}
              </>
            )}
          </div>
        </div>
      </Form>
      <p>
        <Link to="/admin/products">Back to products</Link>
      </p>
    </>
  );
}
