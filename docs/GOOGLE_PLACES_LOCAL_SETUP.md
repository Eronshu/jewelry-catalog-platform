# Google Places: optional local integration / #37

Updated 2026-10-21. Local adapter prepared; **real provider integration not verified, issue acceptance incomplete**. This does not enable public checkout, payment or deployment. Default shopping preview still supports manual entry with no Google script. No customer account or address book is introduced.

## Before using a real key

The owner must authorize a separate test project and its billing, select a budget/support owner, and configure the key themselves. Do not send keys, passwords or billing details to chat, issues or commits. Development has not created an account, activated billing or contacted Google with a real credential.

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

| Check                                                       | Local evidence                                                                          | Still needed for issue acceptance                                                                                       |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| No config / pickup / before opt-in                          | Unit tests; configured dummy-key browser smoke showed zero Google scripts before opt-in | Confirm actual browser network behavior with the approved test project                                                  |
| Components / unit / missing fields / non-CA                 | Mapping and stub-widget integration tests; incomplete fields cannot quote               | Real Canadian suggestion shapes, incomplete results and attribution on selected details                                 |
| New edit / new search / cart or method change / quote reset | Late-response and invalidation tests                                                    | Real widget event behavior and keyboard selection                                                                       |
| SDK, details, authorization errors and timeouts             | Stub/bootstrap failures use manual fallback; no retry storm                             | Restricted/denied key, quota/network failure, console behavior without exposing credentials, manual quote still works   |
| Accessibility / mobile                                      | Existing manual form and status messages; local browser smoke only                      | Keyboard, screen reader, suggestion focus, scrolling, text zoom, unit entry and real iPhone Safari with provider widget |
| Cost / privacy / data retention                             | Minimal fields, opt-in, no application persistence or analytics                         | Owner-approved billing/quotas; policies/attribution/CSP checks; storage review before future order persistence          |

Automated mocks, a fake key and a desktop browser are not substitutes for these checks. Keep #37 open until evidence is recorded. Record provider version/date, restricted test environment and outcomes, never key values or personal search history. Live payments and production remain outside this task.

## Stop and rollback

Stop this runner, then restart without **both** Google settings. Manual entry and all existing local quote tests remain available. Reload the page after a failed SDK bootstrap; it intentionally does not repeatedly reload or adopt an SDK initialized by an unknown key. A revert PR can remove the adapter and key bridge while retaining the prior delivery form. No schema, order, inventory or payment mutation is added here.
