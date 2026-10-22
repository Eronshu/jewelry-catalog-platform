import { useEffect, useRef, useState } from "react";
import {
  loadGooglePlaces,
  type PlaceSelectionEvent,
} from "../../lib/commerce/google-places.client";
import {
  mapCanadianPlace,
  type SuggestedAddress,
} from "../../lib/commerce/place-address";

type Props = {
  apiKey: string | null;
  onBegin: () => (address: SuggestedAddress) => boolean;
  onSearchEdit: () => void;
  load?: typeof loadGooglePlaces;
};
export function GoogleAddressSearch({
  apiKey,
  onBegin,
  onSearchEdit,
  load = loadGooglePlaces,
}: Props) {
  const [requested, setRequested] = useState(false);
  const [status, setStatus] = useState("");
  const host = useRef<HTMLDivElement>(null);
  // Event callbacks stay current without rebuilding the widget on each keystroke.
  const callbacks = useRef({ onBegin, onSearchEdit });
  useEffect(() => {
    callbacks.current = { onBegin, onSearchEdit };
  }, [onBegin, onSearchEdit]);
  useEffect(() => {
    if (!requested || !apiKey) return;
    let disposed = false,
      unavailable = false,
      generation = 0;
    let widget: HTMLElement | undefined;
    let detailsTimer: number | undefined;
    const fail = () => {
      if (disposed) return;
      unavailable = true;
      generation++;
      window.clearTimeout(detailsTimer);
      setStatus(
        "Google address search is unavailable. Enter your address below.",
      );
      widget?.remove();
    };
    // A gmp-error describes one backend request, not the widget's lifetime.
    // During real typing an earlier request can fail while newer suggestions
    // still arrive. Keep the official widget usable; never correlate this event
    // with a pending details request whose ID the event does not provide.
    const searchError = () => {
      if (disposed || unavailable) return;
      setStatus(
        "Google address search could not complete. You can keep searching or enter your address below.",
      );
    };
    const detailsFailed = () => {
      if (disposed || unavailable) return;
      generation++;
      window.clearTimeout(detailsTimer);
      searchError();
    };
    const edit = () => {
      if (disposed || unavailable) return;
      generation++;
      window.clearTimeout(detailsTimer);
      callbacks.current.onSearchEdit();
      setStatus(
        "Choose an address suggestion, then review the editable fields below.",
      );
    };
    const select = async (event: Event) => {
      if (disposed || unavailable) return;
      const selection = ++generation;
      const apply = callbacks.current.onBegin();
      window.clearTimeout(detailsTimer);
      detailsTimer = window.setTimeout(detailsFailed, 10_000);
      setStatus("Loading the selected address… You can also type below.");
      try {
        const place = (event as PlaceSelectionEvent).placePrediction.toPlace();
        // The widget forwards its session token to this first fetchFields call.
        await place.fetchFields({ fields: ["addressComponents"] });
        if (disposed || unavailable || generation !== selection) return;
        window.clearTimeout(detailsTimer);
        const address = mapCanadianPlace(place.addressComponents);
        if (!address) {
          setStatus("Choose a Canadian address or enter it manually below.");
          return;
        }
        const applied = apply(address);
        setStatus(
          applied
            ? "Address suggestion filled. Check every field, including apartment/unit, and complete any missing details."
            : "Your details changed while the address loaded. They were kept; choose again if needed.",
        );
      } catch {
        if (!disposed && generation === selection) detailsFailed();
      }
    };
    load(apiKey)
      .then((library) => {
        if (disposed) return;
        widget = new library.PlaceAutocompleteElement({
          includedRegionCodes: ["ca"],
          requestedLanguage: "en",
          requestedRegion: "ca",
          placeholder: "Search Canadian address",
          description:
            "Search a Canadian delivery address with Google. You can also enter it manually below.",
        });
        widget.setAttribute(
          "aria-label",
          "Search Canadian address with Google",
        );
        widget.addEventListener("input", edit);
        widget.addEventListener("gmp-select", select);
        widget.addEventListener("gmp-error", searchError);
        host.current?.replaceChildren(widget);
        setStatus(
          "Choose an address suggestion, then review the editable fields below.",
        );
      })
      .catch(fail);
    return () => {
      disposed = true;
      generation++;
      window.clearTimeout(detailsTimer);
      widget?.removeEventListener("input", edit);
      widget?.removeEventListener("gmp-select", select);
      widget?.removeEventListener("gmp-error", searchError);
      widget?.remove();
    };
  }, [requested, apiKey, load]);

  return (
    <section className="places-search" aria-label="Optional address search">
      {!apiKey ? (
        <p>
          Address suggestions are unavailable in this preview. Enter your
          address below.
        </p>
      ) : (
        <>
          {!requested && (
            <button
              type="button"
              className="commerce-secondary-button"
              onClick={() => {
                setRequested(true);
                setStatus(
                  "Loading Google address search… Manual entry is still available.",
                );
              }}
            >
              Search address with Google
            </button>
          )}
          <p>
            Optional: address search text is sent to Google. You can always
            enter your address manually below.
          </p>
          <div ref={host} className="places-widget-host" />
          <p role="status">{status}</p>
        </>
      )}
    </section>
  );
}
