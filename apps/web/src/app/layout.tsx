import { ClerkProvider } from "@clerk/nextjs";
import type { Metadata } from "next";
import { Header } from "./components/Header";
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
		<ClerkProvider>
			<html lang="ja">
				<body>
					<Header />
					{children}
				</body>
			</html>
		</ClerkProvider>
	);
}
