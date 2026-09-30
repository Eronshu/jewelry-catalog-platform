import type { Route } from "./+types/home";

export function meta({}: Route.MetaArgs) {
  return [
    { title: "Jewelry Catalog" },
    {
      name: "description",
      content: "A polished jewelry catalog experience is coming soon.",
    },
  ];
}

export default function Home() {
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col justify-center px-6 py-16">
      <p className="text-sm font-medium uppercase tracking-[0.2em] text-neutral-500">
        Jewelry Catalog
      </p>
      <h1 className="mt-4 text-4xl font-semibold tracking-tight sm:text-5xl">
        Application scaffold ready
      </h1>
      <p className="mt-5 max-w-xl text-lg leading-8 text-neutral-600">
        The storefront and owner tools will be built here in focused phases.
      </p>
    </main>
  );
}
