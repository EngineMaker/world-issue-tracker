"use client";

import { getUiMessages, Locale } from "@world-issue-tracker/shared";
import { usePathname, useSearchParams } from "next/navigation";

/**
 * 表示言語の切り替え（Issue #82）。
 *
 * `/locale?lang=xx&next=<いまのパス>` への素のリンクにしている。
 * `onClick` で `document.cookie` を書くと、Server Component の描画は
 * すでに終わっているため再読み込みするまで文言が変わらない。
 * リンクなら Route Handler が Cookie を書いてリダイレクトし、
 * 戻ってきた描画がそのまま切り替え後の言語になる。JS 無効でも動く。
 *
 * `<Link>` ではなく `<a>` にしているのは、`Link` のクライアント遷移だと
 * Route Handler へのナビゲーションとして扱われず、Cookie を書く前に
 * 遷移が完結しうるため。ここはフルリロードでよい（言語は滅多に変えない）。
 *
 * Client Component なのは、戻り先（いまのパス）を知る必要があるため。
 * 表示する文言そのものは props で受け取る。ここで `getUiMessages` を
 * 呼ぶとサーバー側の描画と食い違う可能性があるため……ではなく、
 * 切り替え先の言語名は各言語自身の表記（日本語 / English）で出すので
 * 現在のロケールに依らない。ラベルだけは現在のロケールに従う。
 */
export function LocaleSwitcher({ locale }: { locale: Locale }) {
	const pathname = usePathname();
	const searchParams = useSearchParams();
	const messages = getUiMessages(locale);

	// 一覧の絞り込み条件はクエリに載っている。言語を変えたときに
	// 条件まで消えると、絞り込み直しになる
	const query = searchParams.toString();
	const next = query ? `${pathname}?${query}` : pathname;

	return (
		<span
			className="locale-switcher"
			style={{ fontSize: "0.85rem", display: "flex", gap: "0.4rem" }}
		>
			<span style={{ color: "#666" }}>{messages.localeSwitcher.label}:</span>
			{Locale.options.map((option, index) => (
				<span key={option}>
					{index > 0 && <span style={{ color: "#ccc" }}> / </span>}
					{option === locale ? (
						// 現在の言語はリンクにしない。押しても何も変わらない導線を出さない
						<strong aria-current="true">
							{messages.localeSwitcher.names[option]}
						</strong>
					) : (
						<a
							href={`/locale?lang=${option}&next=${encodeURIComponent(next)}`}
							hrefLang={option}
						>
							{messages.localeSwitcher.names[option]}
						</a>
					)}
				</span>
			))}
		</span>
	);
}
