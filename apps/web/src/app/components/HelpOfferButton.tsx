"use client";

import { SignInButton, useAuth } from "@clerk/nextjs";
import { useState } from "react";
import {
	fetchHelpOffers,
	HelpOfferError,
	type HelpOfferSummary,
	offerHelp,
	withdrawHelp,
} from "../../lib/help-offers";

/**
 * 「手伝います」の表明と取り消しを行うボタン。
 *
 * 件数の初期値は Server Component 側（詳細ページ）が取得して props で渡す。
 * この画面を開いた時点の件数がサーバー側の描画に含まれるので、JS の実行前でも
 * 「何人が動こうとしているか」は読める。押した後の更新だけをこちらで行う。
 *
 * `initialSummary` が null のときは、表明の取得そのものに失敗している。
 * Issue 本体は表示できているので、ボタンを消してその旨だけを出す。
 */
export function HelpOfferButton({
	issueId,
	initialSummary,
}: {
	issueId: string;
	initialSummary: HelpOfferSummary | null;
}) {
	const { isLoaded, isSignedIn, getToken } = useAuth();

	const [summary, setSummary] = useState(initialSummary);
	const [isSubmitting, setIsSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);

	if (!summary) {
		return (
			<p className="text-warning">
				手伝いの表明を取得できませんでした。時間をおいて再度お試しください。
			</p>
		);
	}

	/**
	 * 表明・取り消しの後に一覧を取り直す。
	 *
	 * 押した結果を手元で加減算して表示することもできるが、その間に他の人が
	 * 表明していると件数がずれる。押した直後は正しい値を見せたい場面なので、
	 * サーバーに聞き直す。
	 *
	 * 取り直しに失敗した場合は、少なくとも自分の操作の結果は反映させる
	 * （押したのに何も変わらない画面にしない）。
	 */
	const refresh = async (token: string | null, fallback: HelpOfferSummary) => {
		const result = await fetchHelpOffers(issueId, { token });
		setSummary(result.ok ? result.summary : fallback);
	};

	const handleClick = async () => {
		setError(null);
		setIsSubmitting(true);

		try {
			const token = await getToken();
			const offering = !summary.viewerOffered;

			if (offering) {
				await offerHelp(issueId, token);
			} else {
				await withdrawHelp(issueId, token);
			}

			// 取り直しに失敗したときに使う、自分の操作だけを反映した値
			await refresh(token, {
				...summary,
				total: summary.total + (offering ? 1 : -1),
				viewerOffered: offering,
			});
		} catch (err) {
			setError(
				err instanceof HelpOfferError
					? err.message
					: "予期しないエラーが発生しました。時間をおいて再度お試しください。",
			);
		} finally {
			setIsSubmitting(false);
		}
	};

	return (
		<section aria-labelledby="help-offers-heading">
			<h2 id="help-offers-heading">解決に動く人</h2>

			<p>
				{summary.total === 0
					? "まだ誰も手を挙げていません。"
					: `${summary.total} 人が「手伝います」と表明しています。`}
			</p>

			{/*
			  未ログインでもボタンの存在は見せる。何ができる場所なのか分からないまま
			  ログインを求めるより、押せるものが分かってから促す方が親切なため
			  （起票フォームと同じ方針）。
			*/}
			{isLoaded && !isSignedIn ? (
				<p>
					<SignInButton mode="modal">
						<button type="button" className="button-primary">
							手伝います
						</button>
					</SignInButton>
					<span> — 表明するにはサインインが必要です</span>
				</p>
			) : (
				<p>
					<button
						type="button"
						className={
							summary.viewerOffered ? "button-secondary" : "button-primary"
						}
						onClick={handleClick}
						disabled={isSubmitting || !isLoaded}
					>
						{isSubmitting
							? "送信中…"
							: summary.viewerOffered
								? "表明を取り消す"
								: "手伝います"}
					</button>
					{summary.viewerOffered && (
						<span> — あなたはこの Issue に手を挙げています</span>
					)}
				</p>
			)}

			{error && <output className="notice text-danger">{error}</output>}

			{summary.offers.length > 0 && (
				<>
					<h3>表明した人</h3>
					{/*
					  API が持っているのは Clerk の内部 ID までで、表示名は無い。
					  ID をそのまま並べても読み手には意味が無く、かといって誰が
					  手を挙げたか分からないと起票者は次の一手を決められない。
					  暫定として ID の一部だけを出し、自分の分は「あなた」と示す。
					  表示名を出すには Clerk Backend API への問い合わせが要る（別途対応）。
					*/}
					<ul>
						{summary.offers.map((offer) => (
							<li key={offer.id}>
								{offer.user_id === summary.viewerUserId
									? "あなた"
									: shortUserId(offer.user_id)}
							</li>
						))}
					</ul>
				</>
			)}
		</section>
	);
}

/**
 * Clerk User ID を短く表示する。
 *
 * `user_2abc...` の形なので、接頭辞を落として先頭 8 文字だけを出す。
 * 個人を特定する情報ではないが、同じ人が複数回出ていないことは確認できる。
 */
export function shortUserId(userId: string): string {
	const withoutPrefix = userId.replace(/^user_/, "");
	return `参加者 ${withoutPrefix.slice(0, 8)}`;
}
