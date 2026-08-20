import type { ClerkProvider } from "@clerk/nextjs";
import { getUiMessages, type Locale } from "@world-issue-tracker/shared";
import type { ComponentProps } from "react";

/**
 * `<ClerkProvider localization>` に渡せる型。`@clerk/nextjs` は
 * `LocalizationResource` を re-export していないため、公開されている
 * `ClerkProvider` の props から取り出す。こうしておけば Clerk 側の型が
 * 変わっても追従し、`title` などのキーの綴り間違いをコンパイル時に検出できる
 * （関数の戻り値へ型注釈を付ける目的。オブジェクトリテラルを直に渡さないと
 * 余剰プロパティ検査が効かない）。
 */
type ClerkLocalization = NonNullable<
	ComponentProps<typeof ClerkProvider>["localization"]
>;

/**
 * Clerk のサインイン用モーダルのタイトルは、既定では Clerk Dashboard の
 * Application name（"Sign in to {{applicationName}}"）を差し込む。その
 * Application name が "World Issu Tracker" と誤っていた（#154）。値は
 * Dashboard 側にあり、リポジトリのコードには存在しないため、Web からは
 * `localization` でタイトルを上書きして直す。
 *
 * 差し込む名称は shared の `siteTitle`（アプリの正式名称）を使う。こうして
 * 名称の出所を一箇所に寄せておけば、Dashboard の設定に依存せず、タブや
 * メタ情報（`layout.tsx` の `generateMetadata`）と綴りがずれない。
 *
 * `title` と `titleCombined` の両方を上書きする。Clerk はサインインと
 * サインアップを 1 枚のカードで扱う「結合フロー」が有効なとき、タイトルを
 * `title` ではなく `titleCombined` から描画する（#154 のモーダルは
 * "Don't have an account? Sign up" が同居する結合フローに見える）。既定の
 * `titleCombined` も applicationName を差し込むため、片方だけだと誤字が残る。
 *
 * モーダルの他の文言は Clerk 既定の英語のままにする（#154 の範囲はタイトルの
 * 誤字のみ。UI 全体の日本語化はスコープ外）。そのためタイトルも英語の
 * "Sign in to ..." に揃える。
 */
export function buildClerkLocalization(locale: Locale): ClerkLocalization {
	const { siteTitle } = getUiMessages(locale).common;
	const title = `Sign in to ${siteTitle}`;
	return {
		signIn: {
			start: {
				title,
				titleCombined: title,
			},
		},
	};
}
