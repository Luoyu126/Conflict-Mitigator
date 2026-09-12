import Link from "next/link";

export default function HomeHero() {
  return (
    <div className="max-w-xl text-center">
      <p className="mb-4 text-xs font-bold uppercase tracking-[0.2em] text-[#747a72]">
        Conflict Mitigator
      </p>
      <h1 className="font-serif text-5xl tracking-tight">
        See the shape of a conversation.
      </h1>
      <p className="mx-auto mt-5 max-w-md leading-7 text-[#656b64]">
        Preview how a live meeting transcript becomes a navigable map of
        topics, tension, and common ground.
      </p>
      <Link
        href="/room/demo"
        className="mt-8 inline-flex rounded-full bg-[#20241f] px-6 py-3 text-sm font-semibold text-white shadow-lg shadow-black/10 transition hover:-translate-y-0.5"
      >
        Open Mind Map preview →
      </Link>
    </div>
  );
}
