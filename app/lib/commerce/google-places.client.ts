// Small documented API surface, not a replacement provider SDK/type package.
export type GooglePlace = {
  addressComponents?: unknown;
  fetchFields(options: { fields: string[] }): Promise<unknown>;
};
export type PlaceSelectionEvent = Event & {
  placePrediction: { toPlace(): GooglePlace };
};
export type PlacesLibrary = {
  PlaceAutocompleteElement: new (options: {
    includedRegionCodes: string[];
    requestedLanguage: string;
    requestedRegion: string;
    placeholder: string;
    description: string;
  }) => HTMLElement;
};
type MapsWindow = Window & {
  google?: { maps: { importLibrary(name: string): Promise<PlacesLibrary> } };
  __velaformPlacesReadyV1?: () => void;
};

let initialization: Promise<PlacesLibrary> | undefined;
let configuredKey: string | undefined;
/** Explicitly called after the visitor opts into address search. Never load on
 * pickup/catalog rendering, never log the key or provider error. A browser key
 * is visible to the visitor by design and must have referrer/API restrictions.
 * A failed SDK bootstrap remains failed for this page; manual entry stays usable.
 */
export function loadGooglePlaces(apiKey: string): Promise<PlacesLibrary> {
  if (!/^AIza[A-Za-z0-9_-]{35}$/.test(apiKey))
    return Promise.reject(new Error("Address search unavailable"));
  if (configuredKey && configuredKey !== apiKey)
    return Promise.reject(
      new Error("Address search configuration changed; reload the page"),
    );
  if (initialization) return initialization;
  configuredKey = apiKey;
  initialization = new Promise((resolve, reject) => {
    const target = window as MapsWindow;
    // Do not adopt an SDK loaded by an unknown account/key or overwrite callbacks.
    if (target.google || target.__velaformPlacesReadyV1) {
      reject(new Error("Address search unavailable"));
      return;
    }
    const script = document.createElement("script");
    let complete = false;
    const fail = () => {
      if (complete) return;
      complete = true;
      window.clearTimeout(timer);
      script.remove();
      target.__velaformPlacesReadyV1 = () => {};
      reject(new Error("Address search unavailable"));
    };
    const timer = window.setTimeout(fail, 10_000);
    target.__velaformPlacesReadyV1 = () => {
      if (complete) return;
      const maps = target.google?.maps;
      if (!maps) {
        fail();
        return;
      }
      Promise.resolve()
        .then(() => maps.importLibrary("places"))
        .then((library) => {
          if (complete) return;
          complete = true;
          window.clearTimeout(timer);
          resolve(library);
        }, fail);
    };
    const params = new URLSearchParams({
      key: apiKey,
      loading: "async",
      libraries: "places",
      callback: "__velaformPlacesReadyV1",
      v: "weekly",
      language: "en",
      region: "CA",
      auth_referrer_policy: "origin",
    });
    script.src = `https://maps.googleapis.com/maps/api/js?${params}`;
    script.async = true;
    script.referrerPolicy = "origin";
    script.onerror = fail;
    document.head.appendChild(script);
  });
  return initialization;
}
