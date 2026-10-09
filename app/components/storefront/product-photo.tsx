import { useEffect, useRef, useState } from "react";

export function productPhotoAlt(name: string, savedAlt: string | null): string {
  const detail = savedAlt?.trim();
  if (!detail) return name;
  return detail.toLowerCase().includes(name.toLowerCase())
    ? detail
    : `${name} — ${detail}`;
}

export function ProductPhoto({
  src,
  alt,
  className = "",
  loading,
  fetchPriority,
}: {
  src: string | null;
  alt: string;
  className?: string;
  loading?: "eager" | "lazy";
  fetchPriority?: "high" | "low" | "auto";
}) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const image = useRef<HTMLImageElement>(null);
  const visible = src !== null && src !== failedSrc;
  const fallbackText = visible ? "Loading photo…" : "Photo unavailable";

  useEffect(() => {
    // A server-rendered image can fail before React attaches onError.
    if (
      src &&
      image.current?.currentSrc &&
      image.current.complete &&
      image.current.naturalWidth === 0
    ) {
      setFailedSrc(src);
    }
  }, [src]);

  return (
    <span className={`product-photo ${className}`}>
      <span className="product-photo-fallback" aria-hidden={visible}>
        {fallbackText}
      </span>
      {visible ? (
        <img
          ref={image}
          alt={alt}
          src={src}
          loading={loading}
          fetchPriority={fetchPriority}
          onError={() => setFailedSrc(src)}
        />
      ) : null}
    </span>
  );
}
