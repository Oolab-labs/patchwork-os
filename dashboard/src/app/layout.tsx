import type { ReactNode } from "react";

export const metadata = {
	title: "Patchwork OS",
	description: "Oversight dashboard — approve, review, replay.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
	return (
		<html lang="en">
			<body
				style={{
					margin: 0,
					fontFamily:
						"ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
					background: "#0b0d10",
					color: "#e6e9ef",
				}}
			>
				<header
					style={{
						display: "flex",
						gap: 16,
						padding: "12px 24px",
						borderBottom: "1px solid #1b2028",
					}}
				>
					<strong>patchwork</strong>
					<nav style={{ display: "flex", gap: 12, fontSize: 14 }}>
						<a href="/activity">activity</a>
						<a href="/approvals">approvals</a>
						<a href="/recipes">recipes</a>
						<a href="/tasks">tasks</a>
						<a href="/metrics">metrics</a>
						<a href="/settings">settings</a>
					</nav>
				</header>
				<main style={{ padding: 24 }}>{children}</main>
			</body>
		</html>
	);
}
