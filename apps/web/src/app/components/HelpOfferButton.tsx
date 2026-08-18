"use client";

import { SignInButton, useAuth } from "@clerk/nextjs";
import {
	DEFAULT_LOCALE,
	getUiMessages,
	type Locale,
} from "@world-issue-tracker/shared";
import { useState } from "react";
import {
	fetchHelpOffers,
	HelpOfferError,
	type HelpOfferSummary,
	offerHelp,
	withdrawHelp,
} from "../../lib/help-offers";
import { COMMENTS_SECTION_ID } from "./CommentSection";

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
	locale = DEFAULT_LOCALE,
}: {
	issueId: string;
	initialSummary: HelpOfferSummary | null;
	locale?: Locale;
}) {
	const { isLoaded, isSignedIn, getToken } = useAuth();
	const messages = getUiMessages(locale);

	const [summary, setSummary] = useState(initialSummary);
	const [isSubmitting, setIsSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);

	if (!summary) {
		return <p className="text-warning">{messages.helpOffer.fetchFailed}</p>;
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
					: messages.common.unexpectedError,
			);
		} finally {
			setIsSubmitting(false);
		}
	};

	return (
		<section aria-labelledby="help-offers-heading">
			<h2 id="help-offers-heading">{messages.helpOffer.heading}</h2>

			{/*
			  表明の件数（#95）。0 件のときも他の空の状態と同じ弱さで出す。
			  以前はここだけクラスが無く、本文と同じ濃さで「まだ誰も…」と
			  出ていて、数がある場合との区別が付かなかった
			*/}
			<p className={summary.total === 0 ? "text-soft" : undefined}>
				{summary.total === 0
					? messages.helpOffer.none
					: messages.helpOffer.count(summary.total)}
			</p>

			{/*
			  未ログインでもボタンの存在は見せる。何ができる場所なのか分からないまま
			  ログインを求めるより、押せるものが分かってから促す方が親切なため
			  （起票フォームと同じ方針）。
			*/}
			{isLoaded && !isSignedIn ? (
				<p className="help-offer-actions">
					<SignInButton mode="modal">
						<button type="button" className="button-primary">
							{messages.helpOffer.offer}
						</button>
					</SignInButton>
					<span className="text-soft">{messages.helpOffer.signInHint}</span>
				</p>
			) : (
				<p className="help-offer-actions">
					<button
						type="button"
						className={
							summary.viewerOffered ? "button-secondary" : "button-primary"
						}
						onClick={handleClick}
						disabled={isSubmitting || !isLoaded}
						// 押した直後に何が起きているかを読み上げにも伝える（#95）
						aria-busy={isSubmitting}
					>
						{isSubmitting
							? messages.common.submitting
							: summary.viewerOffered
								? messages.helpOffer.withdraw
								: messages.helpOffer.offer}
					</button>
					{summary.viewerOffered && (
						<span className="text-soft">{messages.helpOffer.youOffered}</span>
					)}
				</p>
			)}

			{/*
			  表明した直後に、次の一手を示す（#114）。
			  以前はここが「あなたはこの Issue に手を挙げています」で終わっていて、
			  手を挙げた人が次に何をすればいいか分からないまま止まっていた。

			  行き先は、この節のすぐ下にあるコメント欄。閉じた場（DM）は
			  作らないと決めているので（#114 の方針）、話す場所は公開の
			  コメント欄一本になる。既にそこにあるものへ進んでよい、と
			  伝えるだけで済む。

			  リンクは Next.js の `Link` ではなく素の `a` にしている。
			  同一ページ内のアンカーで、遷移も先読みも起きないため。
			*/}
			{summary.viewerOffered && (
				<p className="notice help-offer-next-step">
					{messages.helpOffer.nextStep}{" "}
					<a href={`#${COMMENTS_SECTION_ID}`}>
						{messages.helpOffer.nextStepLink}
					</a>
				</p>
			)}

			{error && <output className="notice text-danger">{error}</output>}

			{summary.offers.length > 0 && (
				<>
					<h3>{messages.helpOffer.offerersHeading}</h3>
					{/*
					  表明者は Clerk の表示名で出す（#108）。API が一覧を返す際に
					  Clerk Backend API へまとめて問い合わせている。
					  名前が取れなかった人（Clerk に未設定、または問い合わせ自体が
					  失敗）は専用の文言にする。起票者が「匿名を選んだ人」と
					  取り違えないよう、Issue 本体の「匿名の方」とは別の言葉。
					  自分の分は誰から見ても分かるよう「あなた」のまま。
					*/}
					<ul>
						{summary.offers.map((offer) => (
							<li key={offer.id}>
								{offer.user_id === summary.viewerUserId
									? messages.helpOffer.you
									: (offer.display_name ?? messages.helpOffer.unnamedOfferer)}
							</li>
						))}
					</ul>
				</>
			)}
		</section>
	);
}
