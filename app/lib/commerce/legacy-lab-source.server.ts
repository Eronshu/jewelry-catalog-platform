/** Static SQL discriminator for the historical zero-tax lab DTO. No request data
 * enters this expression. New mapped orders retain their distinct contract and
 * cannot be relabelled by the create-only origin/root guards. This also works
 * when upgrade fixtures use a historical schema before the origin table exists. */
export function legacyLabSource(source: "plain" | "order" | "quote" = "plain") {
  const column = {
    plain: "snapshot",
    order: "o.snapshot",
    quote: "q.snapshot",
  }[source];
  return `json_type(${column}) IS 'object'
    AND json_type(${column},'$.testOnly') IS 'true'
    AND json_extract(${column},'$.currency') IS 'CAD'
    AND json_extract(${column},'$.rulesVersion') IS 'local-test-v1'
    AND json_type(${column},'$.taxCents') IS 'integer'
    AND json_extract(${column},'$.taxCents') IS 0
    AND json_type(${column},'$.contractVersion') IS NULL
    AND json_type(${column},'$.fixtureProfile') IS NULL`;
}
