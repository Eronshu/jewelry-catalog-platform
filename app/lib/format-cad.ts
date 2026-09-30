const cadFormatter = new Intl.NumberFormat("en-CA", {
  style: "currency",
  currency: "CAD",
});

export function formatCad(priceCents: number): string {
  return cadFormatter.format(priceCents / 100);
}
