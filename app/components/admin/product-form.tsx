import { useEffect, useRef, useState, type ReactNode } from "react";
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

function StandaloneNavigationGuard({
  shouldWarn,
  pending,
  submitting,
}: {
  shouldWarn: boolean;
  pending: boolean;
  submitting: React.RefObject<boolean>;
}) {
  const blocker = useBlocker(
    () => shouldWarn && !pending && !submitting.current,
  );
  useEffect(() => {
    if (blocker.state === "blocked") {
      if (window.confirm("Leave without saving your changes?"))
        blocker.proceed();
      else blocker.reset();
    }
  }, [blocker]);
  useBeforeUnload((event) => {
    if (shouldWarn && !pending && !submitting.current) {
      event.preventDefault();
      event.returnValue = "";
    }
  });
  return null;
}

export function ProductForm({
  categories,
  initial,
  feedback,
  version,
  status,
  requestKey,
  photoCount = 0,
  onDirtyChange,
  onSubmittingChange,
  confirmBeforeSubmit,
  onCreateSubmit,
  locked = false,
  saveBusy = false,
  photoEditor,
}: {
  categories: Category[];
  initial?: ProductFields;
  feedback?: FormFeedback;
  version?: number;
  status?: ProductStatus;
  requestKey?: string;
  photoCount?: number;
  onDirtyChange?: (dirty: boolean) => void;
  onSubmittingChange?: (submitting: boolean) => void;
  confirmBeforeSubmit?: () => boolean;
  onCreateSubmit?: (form: HTMLFormElement) => void;
  locked?: boolean;
  saveBusy?: boolean;
  photoEditor?: ReactNode;
}) {
  const [values, setValues] = useState<ProductFields>(
    feedback?.fields ?? initial ?? emptyFields,
  );
  const [dirty, setDirty] = useState(false);
  const submittingThisForm = useRef(false);
  const navigation = useNavigation();
  const pending = navigation.state === "submitting";
  const shouldWarn = dirty || Boolean(feedback?.error);
  useEffect(() => {
    if (feedback?.error) {
      submittingThisForm.current = false;
      onSubmittingChange?.(false);
    }
  }, [feedback, onSubmittingChange]);
  const errors = feedback?.fieldErrors ?? {};
  const setField = (key: keyof ProductFields, value: string) =>
    setValues((current) => ({ ...current, [key]: value }));
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
          value={values[key]}
          onChange={(event) => setField(key, event.target.value)}
          disabled={archived || locked}
          rows={5}
          aria-invalid={Boolean(errors[key])}
          aria-required={options.required}
          aria-describedby={errors[key] ? `${key}-error` : undefined}
        />
      ) : (
        <input
          name={key}
          type={options?.type ?? "text"}
          value={values[key]}
          onChange={(event) => setField(key, event.target.value)}
          disabled={archived || locked}
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
      {!onDirtyChange && (
        <StandaloneNavigationGuard
          shouldWarn={shouldWarn}
          pending={pending}
          submitting={submittingThisForm}
        />
      )}
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
        onChange={(event) => {
          const name = (event.target as HTMLElement).getAttribute("name");
          if (!name || !(name in emptyFields)) return;
          setDirty(true);
          onDirtyChange?.(true);
        }}
        onSubmit={(event) => {
          if (onCreateSubmit) {
            event.preventDefault();
            onCreateSubmit(event.currentTarget);
            return;
          }
          const submitter = (event.nativeEvent as SubmitEvent)
            .submitter as HTMLButtonElement | null;
          if (
            submitter?.value === "archive" &&
            !window.confirm(
              "Archive this product? It will move out of the normal product list.",
            )
          ) {
            submittingThisForm.current = false;
            onSubmittingChange?.(false);
            event.preventDefault();
          } else if (confirmBeforeSubmit && !confirmBeforeSubmit()) {
            submittingThisForm.current = false;
            onSubmittingChange?.(false);
            event.preventDefault();
          } else {
            submittingThisForm.current = true;
            onSubmittingChange?.(true);
            setDirty(false);
            onDirtyChange?.(false);
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
          <h2>
            {locked
              ? "Saved product details"
              : version === undefined
                ? "Create a product"
                : "Edit product"}
          </h2>
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
                value={values.categoryId}
                onChange={(event) => setField("categoryId", event.target.value)}
                disabled={archived || locked}
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
        {photoEditor}
        <div className="admin-form-footer">
          {version === undefined && !locked && (
            <p className="admin-form-draft-note">
              <strong>Save as Draft</strong>
              <span>
                Enter details and choose photos, then Save once. The Draft stays
                private until you publish it.
              </span>
            </p>
          )}
          {publicationUnavailable && !locked && (
            <p className="admin-note">
              Add a photo before showing this product.
            </p>
          )}
          {!locked && (
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
                    disabled={pending || saveBusy}
                  >
                    {saveBusy ? "Saving Draft…" : pending ? "Saving…" : "Save"}
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
          )}
        </div>
      </Form>
      <p>
        <Link to="/admin/products">Back to products</Link>
      </p>
    </>
  );
}
