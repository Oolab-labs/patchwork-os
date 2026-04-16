export default function ActivityPage() {
	return (
		<section>
			<h2>Activity</h2>
			<p style={{ opacity: 0.7 }}>
				Live tool-call feed (WebSocket client lands in next PR). For now this
				page serves as a placeholder so the router resolves.
			</p>
			<pre
				style={{
					background: "#12161d",
					padding: 16,
					borderRadius: 8,
					fontSize: 12,
				}}
			>
				{`// Next: stream from ws://127.0.0.1:<bridge-port>/stream`}
			</pre>
		</section>
	);
}
