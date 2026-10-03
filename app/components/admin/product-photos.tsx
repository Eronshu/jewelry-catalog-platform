import { useEffect, useMemo, useRef, useState } from "react";
import { useBeforeUnload, useFetcher } from "react-router";
import type {
  AdminPhoto,
  AdminPhotoSnapshot,
} from "../../lib/db/admin-product-photos.server";

interface PendingPhoto {
  id: string;
  file: File;
  preview: string;
  progress: number;
  state: "ready" | "uploading" | "finishing" | "saved" | "failed";
  error?: string;
  invalid?: boolean;
}
export interface PhotoQueueState {
  total: number;
  unresolved: number;
  active: boolean;
  saved: number;
  failed: number;
}
type PhotoReply = AdminPhotoSnapshot | { error: string; code?: string };
const maxPhotoBytes = 18_000_000;
const validTypes = new Set(["image/jpeg", "image/png", "image/webp"]);

function previewUrl(productId: number, photoId: number) {
  return `/admin/products/${productId}/photos/${photoId}/preview`;
}

function isAdminPhoto(value: unknown): value is AdminPhoto {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const photo = value as Record<string, unknown>;
  const dimension = (size: unknown) =>
    size === null ||
    (typeof size === "number" && Number.isSafeInteger(size) && size > 0);
  return (
    typeof photo.id === "number" &&
    Number.isSafeInteger(photo.id) &&
    photo.id > 0 &&
    typeof photo.sortOrder === "number" &&
    Number.isSafeInteger(photo.sortOrder) &&
    photo.sortOrder >= 0 &&
    typeof photo.altText === "string" &&
    dimension(photo.width) &&
    dimension(photo.height)
  );
}

function isAdminPhotoSnapshot(value: unknown): value is AdminPhotoSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const snapshot = value as Record<string, unknown>;
  if (
    typeof snapshot.version !== "number" ||
    !Number.isSafeInteger(snapshot.version) ||
    snapshot.version < 1 ||
    typeof snapshot.businessVersion !== "number" ||
    !Number.isSafeInteger(snapshot.businessVersion) ||
    snapshot.businessVersion < 1 ||
    snapshot.businessVersion > snapshot.version ||
    !Array.isArray(snapshot.photos) ||
    snapshot.photos.length > 100 ||
    !snapshot.photos.every(isAdminPhoto)
  )
    return false;
  const photos = snapshot.photos as AdminPhoto[];
  return (
    new Set(photos.map((photo) => photo.id)).size === photos.length &&
    new Set(photos.map((photo) => photo.sortOrder)).size === photos.length
  );
}

export function ProductPhotos({
  productId,
  status,
  initialPhotos,
  version,
  businessVersion,
  onVersion,
  onUploadActiveChange,
  createMode = false,
  onQueueChange,
  selectionLocked = false,
  shouldStopQueuedUploads,
  previewUrlForPhoto = previewUrl,
  hidePicker = false,
}: {
  productId: number | null;
  status: string;
  initialPhotos: AdminPhoto[];
  version: number;
  businessVersion: number;
  onVersion: (
    version: number,
    businessVersion: number,
    photos: AdminPhoto[],
  ) => void;
  onUploadActiveChange?: (active: boolean) => void;
  createMode?: boolean;
  onQueueChange?: (state: PhotoQueueState) => void;
  selectionLocked?: boolean;
  shouldStopQueuedUploads?: () => boolean;
  previewUrlForPhoto?: (productId: number, photoId: number) => string;
  hidePicker?: boolean;
}) {
  const [photos, setPhotos] = useState(initialPhotos);
  const [photoVersion, setPhotoVersion] = useState(version);
  const [queue, setQueue] = useState<PendingPhoto[]>([]);
  const queueRef = useRef<PendingPhoto[]>([]);
  const [message, setMessage] = useState("");
  const [conflict, setConflict] = useState(false);
  const [altDrafts, setAltDrafts] = useState<Record<number, string>>({});
  const [unavailablePreviews, setUnavailablePreviews] = useState<Set<number>>(
    () => new Set(),
  );
  const fetcher = useFetcher<PhotoReply>();
  const handledData = useRef<PhotoReply | undefined>(undefined);
  const orderSubmitted = useRef(false);
  const photoConflictRef = useRef(false);
  const uploadRunning = useRef(false);
  const mounted = useRef(false);
  const [batchRunning, setBatchRunning] = useState(false);
  const initialUploadStarted = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  const dragSource = useRef<number | null>(null);
  const dragTargetRef = useRef<number | null>(null);
  const dragPointerId = useRef<number | null>(null);
  const [draggingPhoto, setDraggingPhoto] = useState<number | null>(null);
  const [dragTarget, setDragTarget] = useState<number | null>(null);
  const pendingDragSource = useRef<string | null>(null);
  const pendingDragTarget = useRef<string | null>(null);
  const pendingDragPointerId = useRef<number | null>(null);
  const [draggingPending, setDraggingPending] = useState<string | null>(null);
  const [pendingTarget, setPendingTarget] = useState<string | null>(null);
  const queueState: PhotoQueueState = useMemo(
    () => ({
      total: queue.length,
      unresolved: queue.filter((item) => item.state !== "saved").length,
      active: queue.some(
        (item) => item.state === "uploading" || item.state === "finishing",
      ),
      saved: queue.filter((item) => item.state === "saved").length,
      failed: queue.filter((item) => item.state === "failed").length,
    }),
    [queue],
  );
  const active =
    batchRunning ||
    fetcher.state !== "idle" ||
    queue.some(
      (item) => item.state === "uploading" || item.state === "finishing",
    );
  const uploadActive = queue.some(
    (item) => item.state === "uploading" || item.state === "finishing",
  );
  const readOnly = status === "archived";
  const displayedQueue = createMode
    ? queue.filter((item) => item.state !== "saved")
    : queue;
  useEffect(() => {
    queueRef.current = queue;
  }, [queue]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      dragPointerId.current = null;
      dragSource.current = null;
      dragTargetRef.current = null;
      pendingDragPointerId.current = null;
      pendingDragSource.current = null;
      pendingDragTarget.current = null;
    };
  }, []);
  useEffect(
    () => () => {
      queueRef.current.forEach((item) => URL.revokeObjectURL(item.preview));
    },
    [],
  );
  useBeforeUnload((event) => {
    if (!onUploadActiveChange && !onQueueChange && active) {
      event.preventDefault();
      event.returnValue = "";
    }
  });
  useEffect(() => {
    onUploadActiveChange?.(uploadActive);
    return () => onUploadActiveChange?.(false);
  }, [onUploadActiveChange, uploadActive]);
  useEffect(() => {
    onQueueChange?.(queueState);
  }, [onQueueChange, queueState]);
  useEffect(() => {
    if (!fetcher.data || fetcher.data === handledData.current) return;
    handledData.current = fetcher.data;
    // A completed router fetcher response updates this component's local photo snapshot.
    if ("error" in fetcher.data) {
      orderSubmitted.current = false;
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setMessage(fetcher.data.error);
      if (
        fetcher.data.code === "stale_product" ||
        fetcher.data.code === "photo_conflict"
      ) {
        setConflict(true);
        photoConflictRef.current = true;
      }
    } else {
      setPhotos(fetcher.data.photos);
      setPhotoVersion(fetcher.data.version);
      onVersion(
        fetcher.data.version,
        fetcher.data.businessVersion,
        fetcher.data.photos,
      );
      setMessage(
        fetcher.data.businessVersion !== businessVersion
          ? "Photos saved. Product details changed elsewhere; review them before saving your entries."
          : orderSubmitted.current
            ? "Photo order saved. The first photo is now the cover."
            : "Photos saved.",
      );
      orderSubmitted.current = false;
      setConflict(false);
      photoConflictRef.current = false;
    }
  }, [fetcher.data, onVersion, businessVersion]);
  const base = `/admin/products/${productId}/photos`;
  const orderedIds = useMemo(() => photos.map((photo) => photo.id), [photos]);
  function pendingFromFile(file: File): PendingPhoto {
    const error = !validTypes.has(file.type)
      ? "Choose a JPEG, PNG, or still WebP photo. HEIC and HEIF are not supported yet."
      : file.size < 1
        ? "This photo is empty."
        : file.size > maxPhotoBytes
          ? "This photo is too large. Choose one under 18 MB."
          : undefined;
    return {
      id: crypto.randomUUID(),
      file,
      preview: URL.createObjectURL(file),
      progress: 0,
      state: error ? "failed" : "ready",
      error,
      invalid: Boolean(error),
    };
  }
  function addFiles(files: FileList | File[]) {
    if (selectionLocked) return;
    const selected = Array.from(files);
    if (!selected.length) return;
    if (
      queue.length + selected.length > 10 ||
      [
        ...queue.map((item) => item.file.size),
        ...selected.map((file) => file.size),
      ].reduce((a, b) => a + b, 0) > 100_000_000
    ) {
      setMessage("Choose up to 10 photos and 100 MB at a time.");
      return;
    }
    const added = selected.map(pendingFromFile);
    setQueue((old) => [...old, ...added]);
    if (input.current) input.current.value = "";
  }
  function replaceFile(id: string, file: File) {
    if (selectionLocked) return;
    if (
      queue.reduce(
        (total, item) => total + (item.id === id ? file.size : item.file.size),
        0,
      ) > 100_000_000
    ) {
      setMessage("Choose up to 10 photos and 100 MB at a time.");
      return;
    }
    const replacement = pendingFromFile(file);
    setQueue((old) =>
      old.map((item) => {
        if (item.id !== id) return item;
        URL.revokeObjectURL(item.preview);
        return replacement;
      }),
    );
  }
  function updatePending(id: string, patch: Partial<PendingPhoto>) {
    setQueue((old) =>
      old.map((item) => (item.id === id ? { ...item, ...patch } : item)),
    );
  }
  async function uploadOne(
    item: PendingPhoto,
    expectedVersion: number,
  ): Promise<number> {
    if (
      !productId ||
      !validTypes.has(item.file.type) ||
      item.file.size < 1 ||
      item.file.size > maxPhotoBytes
    )
      return expectedVersion;
    updatePending(item.id, {
      state: "uploading",
      progress: 0,
      error: undefined,
    });
    let sha256: string;
    try {
      const bytes = await item.file.arrayBuffer();
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      sha256 = Array.from(new Uint8Array(digest), (b) =>
        b.toString(16).padStart(2, "0"),
      ).join("");
    } catch {
      updatePending(item.id, {
        state: "failed",
        error: "Could not read this photo. Try selecting it again.",
        invalid: true,
      });
      return expectedVersion;
    }
    return new Promise<number>((resolve) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", `${base}/upload`);
      xhr.setRequestHeader("Content-Type", item.file.type);
      xhr.setRequestHeader("X-Upload-Id", item.id);
      xhr.setRequestHeader("X-Photo-Sha256", sha256);
      xhr.setRequestHeader("X-Product-Version", String(expectedVersion));
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable)
          updatePending(item.id, {
            progress: Math.round((event.loaded / event.total) * 100),
          });
        if (event.lengthComputable && event.loaded === event.total)
          updatePending(item.id, { state: "finishing" });
      };
      xhr.onload = () => {
        let response: unknown;
        try {
          response = JSON.parse(xhr.responseText);
        } catch {
          response = { error: "Upload failed. Retry this photo." };
        }
        if (
          xhr.status >= 200 &&
          xhr.status < 300 &&
          isAdminPhotoSnapshot(response)
        ) {
          updatePending(item.id, { state: "saved", progress: 100 });
          setPhotos(response.photos);
          setPhotoVersion(response.version);
          onVersion(
            response.version,
            response.businessVersion,
            response.photos,
          );
          setMessage(
            response.businessVersion === businessVersion
              ? "Photos saved."
              : "Photos saved. Product details changed elsewhere; review them before saving your entries.",
          );
          setConflict(false);
          photoConflictRef.current = false;
          resolve(response.version);
        } else {
          const failure =
            response && typeof response === "object"
              ? (response as Record<string, unknown>)
              : {};
          const error =
            typeof failure.error === "string"
              ? failure.error
              : "Upload failed. Retry this photo.";
          updatePending(item.id, {
            state: "failed",
            error,
            invalid:
              xhr.status === 400 ||
              xhr.status === 413 ||
              xhr.status === 415 ||
              failure.code === "upload_identity_conflict",
          });
          if (
            failure.code === "stale_product" ||
            failure.code === "photo_conflict"
          ) {
            setConflict(true);
            photoConflictRef.current = true;
          }
          resolve(expectedVersion);
        }
      };
      xhr.onerror = () => {
        updatePending(item.id, {
          state: "failed",
          error: "Network error. Retry this photo.",
        });
        resolve(expectedVersion);
      };
      xhr.send(item.file);
    });
  }
  async function uploadReady(
    items: PendingPhoto[],
    startVersion = photoVersion,
  ) {
    if (
      !productId ||
      uploadRunning.current ||
      conflict ||
      !mounted.current ||
      shouldStopQueuedUploads?.()
    )
      return;
    uploadRunning.current = true;
    setBatchRunning(true);
    let nextVersion = startVersion;
    try {
      for (const item of items) {
        if (!mounted.current || shouldStopQueuedUploads?.()) break;
        if (item.state !== "ready" && item.state !== "failed") continue;
        nextVersion = await uploadOne(item, nextVersion);
        if (photoConflictRef.current) break;
      }
    } finally {
      uploadRunning.current = false;
      if (mounted.current) {
        setBatchRunning(false);
        if (createMode) setQueue((old) => [...old]);
      }
    }
  }
  useEffect(() => {
    if (!createMode || !productId || uploadRunning.current || conflict) return;
    const ready = queue.filter((item) => item.state === "ready");
    if (!ready.length) return;
    const startVersion = initialUploadStarted.current ? photoVersion : version;
    initialUploadStarted.current = true;
    void uploadReady(ready, startVersion);
    // The queue or product version changes when another upload can start.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [createMode, productId, queue, photoVersion, version, conflict]);
  function submitOrder(ids: number[]) {
    setMessage("");
    orderSubmitted.current = true;
    fetcher.submit(
      {
        intent: "reorder",
        version: String(photoVersion),
        order: ids.join(","),
      },
      { method: "post", action: base },
    );
  }
  function move(id: number, destination: number) {
    const ids = [...orderedIds];
    const from = ids.indexOf(id);
    if (
      from < 0 ||
      destination < 0 ||
      destination >= ids.length ||
      from === destination
    )
      return;
    ids.splice(from, 1);
    ids.splice(destination, 0, id);
    submitOrder(ids);
  }
  function movePending(id: string, destination: number) {
    if (selectionLocked || active) return;
    setQueue((old) => {
      const from = old.findIndex((item) => item.id === id);
      if (
        from < 0 ||
        destination < 0 ||
        destination >= old.length ||
        from === destination
      )
        return old;
      const next = [...old];
      next.splice(destination, 0, ...next.splice(from, 1));
      return next;
    });
    setMessage("Selected photo order changed. Photos upload in this order.");
  }
  function cancelPhotoDrag() {
    dragPointerId.current = null;
    dragSource.current = null;
    dragTargetRef.current = null;
    setDraggingPhoto(null);
    setDragTarget(null);
  }
  function finishPhotoDrag(pointerId: number) {
    if (dragPointerId.current !== pointerId) return;
    const source = dragSource.current;
    const targetPhoto = dragTargetRef.current;
    cancelPhotoDrag();
    if (
      !active &&
      !conflict &&
      !readOnly &&
      photos.length > 1 &&
      source !== null &&
      targetPhoto !== null &&
      source !== targetPhoto
    ) {
      const ids = [...orderedIds];
      const from = ids.indexOf(source);
      const target = ids.indexOf(targetPhoto);
      if (from !== -1 && target !== -1) {
        ids.splice(from, 1);
        ids.splice(target, 0, source);
        submitOrder(ids);
      }
    }
  }
  function cancelPendingDrag() {
    pendingDragPointerId.current = null;
    pendingDragSource.current = null;
    pendingDragTarget.current = null;
    setDraggingPending(null);
    setPendingTarget(null);
  }
  function finishPendingDrag(pointerId: number) {
    if (pendingDragPointerId.current !== pointerId) return;
    const source = pendingDragSource.current;
    const target = pendingDragTarget.current;
    cancelPendingDrag();
    if (!selectionLocked && !active && source && target && source !== target) {
      setQueue((old) => {
        const next = [...old];
        const from = next.findIndex((item) => item.id === source);
        const to = next.findIndex((item) => item.id === target);
        if (from < 0 || to < 0) return old;
        next.splice(to, 0, ...next.splice(from, 1));
        return next;
      });
      setMessage("Selected photo order changed. Photos upload in this order.");
    }
  }
  useEffect(() => {
    if (active || conflict || readOnly || photos.length < 2) {
      dragPointerId.current = null;
      dragSource.current = null;
      dragTargetRef.current = null;
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setDraggingPhoto(null);
      setDragTarget(null);
    }
    if (selectionLocked || active) {
      pendingDragPointerId.current = null;
      pendingDragSource.current = null;
      pendingDragTarget.current = null;
      setDraggingPending(null);
      setPendingTarget(null);
    }
  }, [active, conflict, readOnly, photos.length, selectionLocked]);
  function submitPhoto(photoId: number, intent: "alt" | "remove") {
    if (intent === "remove") {
      const position = photos.findIndex((photo) => photo.id === photoId);
      if (position < 0) return;
      const description = photos[position].altText.replace(/\s+/g, " ").trim();
      const characters = Array.from(description);
      const label = description
        ? `${characters.slice(0, 80).join("")}${characters.length > 80 ? "…" : ""}`
        : "No description";
      if (
        !window.confirm(
          `Remove saved photo ${position + 1} of ${photos.length} (“${label}”)? This cannot be undone.`,
        )
      )
        return;
    }
    setMessage("");
    fetcher.submit(
      {
        intent,
        version: String(photoVersion),
        altText:
          altDrafts[photoId] ??
          photos.find((photo) => photo.id === photoId)?.altText ??
          "",
      },
      { method: "post", action: `${base}/${photoId}` },
    );
  }
  async function refreshPhotos() {
    try {
      const response = await fetch(base, {
        credentials: "same-origin",
        cache: "no-store",
      });
      if (!response.ok) throw new Error("Photo refresh failed");
      const fresh: unknown = await response.json();
      if (!isAdminPhotoSnapshot(fresh))
        throw new Error("Invalid photo snapshot");
      setUnavailablePreviews(new Set());
      setPhotos(fresh.photos);
      setPhotoVersion(fresh.version);
      onVersion(fresh.version, fresh.businessVersion, fresh.photos);
      setMessage(
        "Photos refreshed. Review changes before retrying. Your unsaved product details are still here.",
      );
      setConflict(false);
      photoConflictRef.current = false;
    } catch {
      setMessage("Could not refresh photos. Try again.");
    }
  }
  return (
    <section
      className="admin-form-section admin-photo-section"
      aria-labelledby="photos-title"
    >
      <div className="admin-form-section-heading">
        <div>
          <h2 id="photos-title">Photos</h2>
          <p>
            {createMode
              ? productId
                ? "Draft saved. Photos upload automatically and stay private until publication."
                : "Choose photos now. Save once to create the Draft and upload valid selections."
              : "Photo changes save immediately. Save product details separately."}
          </p>
        </div>
      </div>
      {message && (
        <p
          role={conflict ? "alert" : "status"}
          className={conflict ? "admin-alert" : "admin-note"}
        >
          {message}
        </p>
      )}
      {conflict && (
        <button type="button" onClick={refreshPhotos}>
          Refresh photos
        </button>
      )}
      {status !== "archived" && !hidePicker && (
        <div
          className="admin-photo-picker"
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            event.preventDefault();
            addFiles(event.dataTransfer.files);
          }}
        >
          <button
            type="button"
            className="admin-photo-picker-trigger"
            disabled={selectionLocked}
            onClick={() => input.current?.click()}
          >
            Add photos
          </button>
          <input
            ref={input}
            id="photo-picker"
            type="file"
            hidden
            aria-label="Add product photos"
            accept="image/jpeg,image/png,image/webp"
            multiple
            disabled={selectionLocked}
            onChange={(event) =>
              event.target.files && addFiles(event.target.files)
            }
          />
          <p>
            JPEG, PNG, or still WebP. Up to 18 MB each. You can also drop photos
            in this area.
          </p>
        </div>
      )}
      {displayedQueue.length > 0 && (
        <div>
          <h3>{createMode ? "Selected photos" : "Ready to upload"}</h3>
          {displayedQueue.length > 1 && !selectionLocked && !active && (
            <p>
              Drag a selected photo by its handle to set the upload order.
              {createMode
                ? " The first saved photo becomes the cover."
                : " New photos follow the existing saved photos."}
            </p>
          )}
          <ul className="admin-photo-grid">
            {displayedQueue.map((item, index) => (
              <li
                key={item.id}
                data-pending-id={item.id}
                className={`admin-photo-card${draggingPending === item.id ? " admin-photo-dragging" : ""}${pendingTarget === item.id ? " admin-photo-drag-target" : ""}`}
              >
                <div className="admin-photo-summary">
                  <img src={item.preview} alt="Local preview, not saved" />
                  <div className="admin-photo-identity">
                    <span className="admin-photo-position">
                      Selected {index + 1}
                    </span>
                    <strong title={item.file.name}>{item.file.name}</strong>
                    <span
                      role="status"
                      className={
                        item.state === "failed"
                          ? "admin-photo-error"
                          : undefined
                      }
                    >
                      {item.state === "uploading"
                        ? `Uploading ${item.progress}%`
                        : item.state === "finishing"
                          ? "Finishing photo…"
                          : item.state === "saved"
                            ? "Saved"
                            : item.state === "failed"
                              ? item.error
                              : "Not uploaded"}
                    </span>
                  </div>
                  {displayedQueue.length > 1 && (
                    <button
                      type="button"
                      className="admin-photo-drag-handle"
                      aria-label={`Drag ${item.file.name} to reorder`}
                      disabled={selectionLocked || active}
                      onPointerDown={(event) => {
                        if (event.pointerType === "mouse" && event.button !== 0)
                          return;
                        if (
                          selectionLocked ||
                          active ||
                          pendingDragPointerId.current !== null
                        )
                          return;
                        pendingDragPointerId.current = event.pointerId;
                        pendingDragSource.current = item.id;
                        setDraggingPending(item.id);
                        try {
                          event.currentTarget.setPointerCapture(
                            event.pointerId,
                          );
                        } catch {
                          cancelPendingDrag();
                        }
                      }}
                      onPointerMove={(event) => {
                        if (
                          pendingDragPointerId.current !== event.pointerId ||
                          pendingDragSource.current === null
                        )
                          return;
                        const card = document
                          .elementFromPoint(event.clientX, event.clientY)
                          ?.closest<HTMLElement>("[data-pending-id]");
                        const target = card?.dataset.pendingId;
                        pendingDragTarget.current =
                          target && target !== pendingDragSource.current
                            ? target
                            : null;
                        setPendingTarget(pendingDragTarget.current);
                      }}
                      onPointerUp={(event) =>
                        finishPendingDrag(event.pointerId)
                      }
                      onPointerCancel={(event) => {
                        if (pendingDragPointerId.current === event.pointerId)
                          cancelPendingDrag();
                      }}
                      onLostPointerCapture={(event) => {
                        if (pendingDragPointerId.current === event.pointerId)
                          cancelPendingDrag();
                      }}
                    >
                      <span aria-hidden="true">☰</span>
                    </button>
                  )}
                </div>
                {item.state === "uploading" && (
                  <progress
                    value={item.progress}
                    max={100}
                    aria-label={`Upload progress for ${item.file.name}`}
                  />
                )}
                <details className="admin-photo-details">
                  <summary>Actions for {item.file.name}</summary>
                  <div className="admin-photo-actions">
                    {displayedQueue.length > 1 && (
                      <>
                        <button
                          type="button"
                          aria-label={`Move selected photo ${index + 1} earlier`}
                          disabled={selectionLocked || active || index === 0}
                          onClick={() => movePending(item.id, index - 1)}
                        >
                          Move earlier
                        </button>
                        <button
                          type="button"
                          aria-label={`Move selected photo ${index + 1} later`}
                          disabled={
                            selectionLocked ||
                            active ||
                            index === displayedQueue.length - 1
                          }
                          onClick={() => movePending(item.id, index + 1)}
                        >
                          Move later
                        </button>
                      </>
                    )}
                    {!createMode &&
                      (item.state === "ready" || item.state === "failed") && (
                        <button
                          type="button"
                          disabled={
                            active || conflict || readOnly || item.invalid
                          }
                          onClick={() => uploadReady([item])}
                        >
                          {item.state === "failed" ? "Retry" : "Upload"}
                        </button>
                      )}
                    {createMode &&
                      productId &&
                      item.state === "failed" &&
                      !item.invalid && (
                        <button
                          type="button"
                          disabled={active || conflict}
                          onClick={() => uploadReady([item])}
                        >
                          Retry
                        </button>
                      )}
                    {createMode &&
                      item.state !== "uploading" &&
                      item.state !== "finishing" &&
                      item.state !== "saved" && (
                        <>
                          <button
                            type="button"
                            disabled={selectionLocked}
                            onClick={() =>
                              document
                                .getElementById(`replace-${item.id}`)
                                ?.click()
                            }
                          >
                            Replace
                          </button>
                          <input
                            hidden
                            id={`replace-${item.id}`}
                            type="file"
                            accept="image/jpeg,image/png,image/webp"
                            aria-label={`Replacement for ${item.file.name}`}
                            onChange={(event) => {
                              const file = event.target.files?.[0];
                              if (file) replaceFile(item.id, file);
                            }}
                          />
                        </>
                      )}
                    {item.state !== "uploading" &&
                      item.state !== "finishing" &&
                      (!createMode || item.state !== "saved") && (
                        <button
                          type="button"
                          disabled={selectionLocked}
                          onClick={() => {
                            URL.revokeObjectURL(item.preview);
                            setQueue((old) =>
                              old.filter((queued) => queued.id !== item.id),
                            );
                          }}
                        >
                          {createMode ? "Remove selection" : "Clear"}
                        </button>
                      )}
                  </div>
                </details>
              </li>
            ))}
          </ul>
          {!createMode && (
            <button
              type="button"
              disabled={active || conflict || readOnly}
              onClick={() =>
                uploadReady(queue.filter((item) => item.state === "ready"))
              }
            >
              Upload ready photos
            </button>
          )}
        </div>
      )}
      {productId !== null && (
        <div>
          <h3>Saved photos</h3>
          {photos.length > 1 && !createMode && (
            <p>
              Drag a photo by its handle to change the order. The first photo is
              the cover. You can also use Move earlier or Move later.
            </p>
          )}
          {photos.length === 0 ? (
            <p>No saved photos yet. Add one before publishing.</p>
          ) : (
            <ol className="admin-photo-grid">
              {photos.map((photo, index) => (
                <li
                  key={photo.id}
                  data-photo-id={photo.id}
                  className={`admin-photo-card${draggingPhoto === photo.id ? " admin-photo-dragging" : ""}${dragTarget === photo.id ? " admin-photo-drag-target" : ""}`}
                >
                  <div className="admin-photo-summary">
                    {unavailablePreviews.has(photo.id) ? (
                      <span
                        className="admin-photo-preview-fallback"
                        role="img"
                        aria-label="Preview unavailable"
                      >
                        Preview unavailable
                      </span>
                    ) : (
                      <img
                        src={previewUrlForPhoto(productId, photo.id)}
                        alt={photo.altText || "Saved product photo"}
                        onError={() =>
                          setUnavailablePreviews((old) =>
                            new Set(old).add(photo.id),
                          )
                        }
                      />
                    )}
                    <div className="admin-photo-identity">
                      <span className="admin-photo-position">
                        Saved {index + 1}
                      </span>
                      <strong>
                        {index === 0 ? "Cover photo" : `Photo ${index + 1}`}
                      </strong>
                      <span>{photo.altText || "Description needed"}</span>
                    </div>
                    {!createMode && (
                      <button
                        type="button"
                        className="admin-photo-drag-handle"
                        aria-label={`Drag photo ${index + 1} to reorder`}
                        disabled={
                          active || conflict || readOnly || photos.length < 2
                        }
                        onPointerDown={(event) => {
                          if (
                            event.pointerType === "mouse" &&
                            event.button !== 0
                          )
                            return;
                          if (
                            active ||
                            conflict ||
                            readOnly ||
                            photos.length < 2 ||
                            dragPointerId.current !== null
                          )
                            return;
                          dragPointerId.current = event.pointerId;
                          dragSource.current = photo.id;
                          setDraggingPhoto(photo.id);
                          try {
                            event.currentTarget.setPointerCapture(
                              event.pointerId,
                            );
                          } catch {
                            cancelPhotoDrag();
                          }
                        }}
                        onPointerMove={(event) => {
                          if (
                            dragPointerId.current !== event.pointerId ||
                            dragSource.current === null
                          )
                            return;
                          const card = document
                            .elementFromPoint(event.clientX, event.clientY)
                            ?.closest<HTMLElement>("[data-photo-id]");
                          const target = Number(card?.dataset.photoId);
                          dragTargetRef.current =
                            orderedIds.includes(target) &&
                            target !== dragSource.current
                              ? target
                              : null;
                          setDragTarget(dragTargetRef.current);
                        }}
                        onPointerUp={(event) =>
                          finishPhotoDrag(event.pointerId)
                        }
                        onPointerCancel={(event) => {
                          if (dragPointerId.current === event.pointerId)
                            cancelPhotoDrag();
                        }}
                        onLostPointerCapture={(event) => {
                          if (dragPointerId.current === event.pointerId)
                            cancelPhotoDrag();
                        }}
                      >
                        <span aria-hidden="true">☰</span>
                      </button>
                    )}
                  </div>
                  {!createMode && (
                    <details className="admin-photo-details">
                      <summary>Actions for photo {index + 1}</summary>
                      <div className="admin-photo-actions">
                        <button
                          type="button"
                          disabled={
                            active || conflict || readOnly || index === 0
                          }
                          onClick={() => move(photo.id, 0)}
                        >
                          Make cover
                        </button>
                        <button
                          type="button"
                          disabled={
                            active || conflict || readOnly || index === 0
                          }
                          aria-label={`Move photo ${index + 1} earlier`}
                          onClick={() => move(photo.id, index - 1)}
                        >
                          Move earlier
                        </button>
                        <button
                          type="button"
                          disabled={
                            active ||
                            conflict ||
                            readOnly ||
                            index === photos.length - 1
                          }
                          aria-label={`Move photo ${index + 1} later`}
                          onClick={() => move(photo.id, index + 1)}
                        >
                          Move later
                        </button>
                      </div>
                      <div className="admin-photo-edit-actions">
                        <label>
                          Describe this photo
                          <input
                            type="text"
                            maxLength={240}
                            disabled={readOnly}
                            value={altDrafts[photo.id] ?? photo.altText}
                            onChange={(event) =>
                              setAltDrafts((old) => ({
                                ...old,
                                [photo.id]: event.target.value,
                              }))
                            }
                          />
                        </label>
                        <button
                          type="button"
                          disabled={
                            active ||
                            conflict ||
                            readOnly ||
                            !(altDrafts[photo.id] ?? photo.altText).trim()
                          }
                          onClick={() => submitPhoto(photo.id, "alt")}
                        >
                          Save description
                        </button>
                        <button
                          type="button"
                          disabled={
                            active ||
                            conflict ||
                            readOnly ||
                            ((status === "available" || status === "sold") &&
                              photos.length === 1)
                          }
                          onClick={() => submitPhoto(photo.id, "remove")}
                        >
                          Remove photo
                        </button>
                      </div>
                    </details>
                  )}
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </section>
  );
}
