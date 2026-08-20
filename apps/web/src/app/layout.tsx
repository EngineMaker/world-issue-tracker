import { ClerkProvider } from "@clerk/nextjs";
import { getUiMessages } from "@world-issue-tracker/shared";
import type { Metadata } from "next";
import { buildClerkLocalization } from "../lib/clerk-localization";
import { getLocale } from "../lib/locale";
import { Header } from "./components/Header";
import "./globals.css";

/**
 * ページのタイトルと説明もロケールに従わせる（Issue #82）。
 *
 * 静的な `metadata` から `generateMetadata` に変えているのは、Cookie を
 * 読む必要があるため。ここを日本語で固定したままにすると、英語で表示している
 * 人のブラウザのタブと検索結果の説明だけが日本語で残る。
 */
export async function generateMetadata(): Promise<Metadata> {
	const messages = getUiMessages(await getLocale());
	return {
		title: messages.common.siteTitle,
		description: messages.common.siteDescription,
	};
}

export default async function RootLayout({
	children,
}: {
	children: React.ReactNode;
}) {
	const locale = await getLocale();
	const messages = getUiMessages(locale);

	return (
		<ClerkProvider localization={buildClerkLocalization(locale)}>
			{/*
			  `lang` は読み上げの発音とブラウザの翻訳提案に効く。日本語で固定すると、
			  英語で表示していても読み上げが日本語の発音規則で読まれる
			*/}
			<html lang={messages.common.htmlLang}>
				<body>
					<Header locale={locale} />
					{children}
				</body>
			</html>
		</ClerkProvider>
	);
}
