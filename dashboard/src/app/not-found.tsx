import Link from "next/link";

export default function NotFound() {
  return (
    <section style={{ padding: "32px 24px", maxWidth: 640 }}>
      <h1 className="editorial-h1">
        Not <span className="accent">found.</span>
      </h1>
      <p className="editorial-sub" style={{ fontFamily: "inherit", marginTop: 8 }}>
        We couldn&apos;t find that page. It may have moved, been renamed, or
        never existed.
      </p>
      <div style={{ marginTop: 24, display: "flex", gap: 12 }}>
        <Link href="/" className="btn">Home</Link>
        <Link href="/marketplace" className="btn btn-secondary">Marketplace</Link>
      </div>
    </section>
  );
}
