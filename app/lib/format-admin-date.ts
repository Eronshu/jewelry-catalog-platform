const adminDateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Toronto",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export function formatAdminDate(timestamp: number): string {
  const parts = Object.fromEntries(
    adminDateFormatter
      .formatToParts(new Date(timestamp))
      .map(({ type, value }) => [type, value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}
