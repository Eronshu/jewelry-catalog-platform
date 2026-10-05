import { useRef, useState } from "react";

import { ProductPhoto, productPhotoAlt } from "./product-photo";

export interface GalleryImage {
  id: number;
  altText: string | null;
  detailUrl: string;
  thumbUrl: string;
  zoomUrl: string;
}

export function ProductGallery({
  name,
  images,
}: {
  name: string;
  images: readonly GalleryImage[];
}) {
  const [selectedId, setSelectedId] = useState(images[0]?.id ?? null);
  const [inspecting, setInspecting] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const selectedIndex = Math.max(
    0,
    images.findIndex((image) => image.id === selectedId),
  );
  const selected = images[selectedIndex];

  function movePhoto(direction: -1 | 1) {
    const next = images[selectedIndex + direction];
    if (!next) return;
    setSelectedId(next.id);
  }

  function openInspection() {
    setInspecting(true);
    dialog.current?.showModal();
    closeButton.current?.focus();
  }

  return (
    <div className="product-gallery">
      <div className="product-gallery-primary">
        <ProductPhoto
          key={selected?.id ?? "missing"}
          className="product-gallery-main-photo"
          src={selected?.detailUrl ?? null}
          alt={productPhotoAlt(name, selected?.altText ?? null)}
          loading="eager"
          fetchPriority="high"
        />
        {images.length > 1 ? (
          <>
            <button
              className="product-gallery-arrow product-gallery-arrow--previous"
              type="button"
              aria-label="Previous photo"
              aria-disabled={selectedIndex === 0}
              onClick={() => movePhoto(-1)}
            >
              <span aria-hidden="true">‹</span>
            </button>
            <button
              className="product-gallery-arrow product-gallery-arrow--next"
              type="button"
              aria-label="Next photo"
              aria-disabled={selectedIndex === images.length - 1}
              onClick={() => movePhoto(1)}
            >
              <span aria-hidden="true">›</span>
            </button>
            <div className="product-gallery-position">
              <span
                aria-label={`Photo ${selectedIndex + 1} of ${images.length}`}
                aria-live="polite"
              >
                {selectedIndex + 1} / {images.length}
              </span>
              <span className="product-gallery-markers" aria-hidden="true">
                {images.map((image, index) => (
                  <span
                    key={image.id}
                    className="product-gallery-marker"
                    data-active={index === selectedIndex}
                  />
                ))}
              </span>
            </div>
          </>
        ) : null}
      </div>
      {selected ? (
        <button
          ref={opener}
          className="product-gallery-inspect"
          type="button"
          onClick={openInspection}
        >
          View larger image
        </button>
      ) : null}
      {images.length > 1 ? (
        <div className="product-gallery-thumbnails" aria-label="Product photos">
          {images.map((image, index) => (
            <button
              key={image.id}
              type="button"
              className="product-gallery-thumbnail"
              aria-label={`View photo ${index + 1} of ${images.length}`}
              aria-pressed={image.id === selected?.id}
              onClick={() => setSelectedId(image.id)}
            >
              <ProductPhoto src={image.thumbUrl} alt="" loading="lazy" />
            </button>
          ))}
        </div>
      ) : null}
      <dialog
        ref={dialog}
        className="product-gallery-dialog"
        aria-label={`Larger image of ${name}`}
        onClose={() => {
          setInspecting(false);
          opener.current?.focus();
        }}
      >
        <div className="product-gallery-dialog-content">
          <button
            ref={closeButton}
            type="button"
            className="product-gallery-close"
            onClick={() => dialog.current?.close()}
          >
            Close image
          </button>
          {inspecting && selected ? (
            <ProductPhoto
              key={selected.id}
              className="product-gallery-zoom-photo"
              src={selected.zoomUrl}
              alt={productPhotoAlt(name, selected.altText)}
            />
          ) : null}
        </div>
      </dialog>
    </div>
  );
}
