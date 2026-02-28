import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
	title: "World Issue Tracker",
	description: "地球のバグを、みんなで可視化して、みんなで直す",
};

export default function RootLayout({
	children,
}: {
	children: React.ReactNode;
}) {
	return (
		<html lang="ja">
			<body>{children}</body>
		</html>
	);
}
