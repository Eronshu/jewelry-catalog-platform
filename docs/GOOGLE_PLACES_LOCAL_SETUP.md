# Google Places: optional local integration / #37

Updated 2026-10-21. **Demo Key backed local browser search → selection → address fields → test quote now verified**, including recovery after individual request errors. Issue acceptance remains incomplete: real iPhone Safari, standard restricted-key configuration and full policy/accessibility checks are still outstanding. This does not enable public checkout, payment or deployment. Default shopping preview supports manual entry with no Google script. No customer account or address book is introduced.

## Before using a real key

For a **standard key**, the owner must authorize a separate test project and its billing, select a budget/support owner, and configure the key themselves. For limited prototype testing, Google also offers a [Maps Demo Key](https://developers.google.com/maps/documentation/javascript/demo-key) without billing details; it has provider limits and cannot be used for production. The owner supplied and authorized such a key for this local test. No account/billing changes were made. Subsequent keys should be configured directly in a private local file, never chat, issues or commits. The same explicit local mode/key-file bridge below is used; this does not establish that Demo Key supports all standard-key restriction options.

1. Review the current [widget setup](https://developers.google.com/maps/documentation/javascript/place-autocomplete-new) and [usage/billing](https://developers.google.com/maps/documentation/places/web-service/usage-and-billing). Confirm Maps JavaScript API and Places API (New) enablement in that test project. Do not infer readiness from a syntactically valid key.
2. Create a separate browser test key with website/referrer restrictions for the exact loopback test origins/ports and API restrictions for the APIs actually required by this widget. Verify the resulting allow/deny behavior; do not remove restrictions to solve errors. The adapter sends origin-only referrers, so path-specific restrictions are unsuitable. Never reuse a payment/server key or a future production key. See [Google security guidance](https://developers.google.com/maps/api-security-best-practices).
3. Check the actual project's available quotas and configure conservative limits/alerts. Review the [current price list](https://developers.google.com/maps/billing-and-pricing/pricing) and [budget options](https://docs.cloud.google.com/billing/docs/how-to/budgets) rather than assuming a free allowance or hard spending cap from ordinary alert-only budgets. No fee has been quoted or verified for this account.
4. Before real use, review [Places policies](https://developers.google.com/maps/documentation/places/web-service/policies), required terms/privacy disclosures and visible Google/third-party attribution. Preserve the official widget attribution. The current local interface notice is not a completed legal/privacy review. Future order-address retention requires its own policy check; user confirmation does not establish a general exemption from provider storage restrictions.

## Local configuration

Put only the test browser key in a private, single-line file **outside the repository**, using an editor/credential workflow that does not echo the key to terminal history. Restrict its permissions to the current user (0600). Do not use a repository `.env`, `.dev.vars`, a shell command containing the key, or a committed fixture.

After the owner's configuration/authorization, run:

```sh
npm run build
COMMERCE_PLACES_MODE=google-test \
COMMERCE_PLACES_KEY_FILE=/absolute/path/outside-repository/browser-test-key \
COMMERCE_LOCAL_PORT=8795 npm run commerce:local
```

Replace the path with the private file location, not the key. Use an unused loopback port; preserve existing servers. Both Google settings are required, the path must be absolute and the value must have the expected browser-key shape. Shape validation cannot prove project ownership, restrictions, billing or provider compatibility. Arbitrary inherited `GOOGLE_API_KEY` values are ignored. The default no-settings run does not read a key file.

The runner reads only this deliberately selected file and writes mode/key into a fresh private temporary `.dev.vars` (0600) next to its temporary Wrangler config. Wrangler treats those values as hidden in startup output. Repository configuration and production bindings are unchanged. This temporary file remains with the test state after stopping; remove/revoke the test configuration through the owner's normal local credential cleanup once investigation is complete. Do not upload the directory/logs as evidence without reviewing them for credentials and addresses.

The local checkout loader returns only this restricted browser key after the loopback gate. It is visible in browser page data and the SDK request; browser configuration is not a secret storage mechanism. No credentials are placed in cart storage. The widget loads only after **Search address with Google** is chosen. Search text goes to Google; use non-personal test locations with no customer identity. Google may not suggest fictional addresses; choose a public test location only after the provider-policy gate is satisfied, then manually review the fields. No location permission or map is needed.

## Behavior and outstanding acceptance

The adapter uses the documented [new widget/events](https://developers.google.com/maps/documentation/javascript/reference/places-widget) and [async script loader](https://developers.google.com/maps/documentation/javascript/load-maps-js-api). It requests Canadian suggestions in English, then only address components on selection. Components populate the editable form; manual unit text is kept. Review every field: a suggestion is not an address-validation service or proof of service coverage. Existing server validation and current price/stock/rule calculations control quotes.

An individual `gmp-error` no longer removes/disables the widget. In the actual local test, request errors were followed by successful suggestions and details. The initial adapter treated the event as permanent SDK failure and removed a still-recoverable control; that application bug is fixed. A request error now shows a manual-entry/retry hint without launching app retries or discarding uncorrelated newer details. Details failures/timeouts cancel only that selection; a new selection remains possible. SDK bootstrap failure still fails closed for that page. The exact cause of every underlying provider/XHR error is not established; no billing upgrade or network/security bypass was used.

| Check                                                       | Local evidence                                                                                                                              | Still needed for issue acceptance                                                                                        |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| No config / pickup / before opt-in                          | Unit tests; dummy-key browser smoke showed zero Google scripts before opt-in                                                                | Repeat under the approved standard-key test project                                                                      |
| Components / unit / missing fields / non-CA                 | Mapping/stub tests; actual Canadian public location filled street/city/province/postcode and retained manual unit, then produced test quote | More real incomplete/ambiguous results and attribution/policy review                                                     |
| New edit / new search / cart or method change / quote reset | Late-response tests; real keyboard selection and subsequent Google input cleared confirmed quote                                            | Broader actual-widget race cases and mobile behavior                                                                     |
| SDK, details, authorization errors and timeouts             | Stub/bootstrap tests; real request error followed by successful widget search/selection/details and manual fallback                         | Standard restricted/denied key and quota-error evidence; complete operational diagnostics                                |
| Accessibility / mobile                                      | Desktop keyboard selection and 390px layout with real widget; manual controls 16px and >=44px, no document overflow                         | Screen reader, suggestion focus/scrolling/text zoom/touch, real iPhone Safari; width simulation is not device acceptance |
| Cost / privacy / data retention                             | Demo-only local probe, minimal fields, opt-in, no application persistence/analytics; no billing activated                                   | Standard-project budget/quotas/restrictions; policies/attribution/CSP checks; storage review before order persistence    |

The initial REST probe returned HTTP 200 and five suggestions but did not establish browser completion. A minimal no-React widget page then reproduced request errors **and** successful suggestions/details, identifying our premature widget removal. After the fix, the compiled local commerce page successfully used the Demo Key for a public Canadian test location, preserved `Unit TEST`, and returned fictional CAD44.00 shipping quote. Actual subsequent Google input cleared its prior quote/confirmation. Temporary evidence: `/tmp/commerce-places-real-success.png`, `/tmp/commerce-places-real-mobile.png`. The test used the SDK weekly channel checked on this date; no provider results were added to fixtures or the database.

Mocks and desktop/mobile-width checks do not complete the outstanding gates. Keep #37 open. Record provider version/date, test environment and outcomes, never key values or personal search history. Live payments and production remain outside this task.

## Stop and rollback

Stop this runner, then restart without **both** Google settings. Manual entry and all existing local quote tests remain available. Reload the page after a failed SDK bootstrap; it intentionally does not repeatedly reload or adopt an SDK initialized by an unknown key. A revert PR can remove the adapter and key bridge while retaining the prior delivery form. No schema, order, inventory or payment mutation is added here.
