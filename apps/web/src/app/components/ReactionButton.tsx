"use client";

import { SignInButton, useAuth } from "@clerk/nextjs";
import {
	DEFAULT_LOCALE,
	getUiMessages,
	type Locale,
} from "@world-issue-tracker/shared";
import { useState } from "react";
import {
	fetchReactions,
	ReactionError,
	type ReactionSummary,
	react,
	withdrawReaction,
} from "../../lib/reactions";

/**
 * 「私も困っている」の反応と取り消しを行うボタン（#112）。
 *
 * `HelpOfferButton` と同じ構造だが、意味が違う。あちらは「動く人」の表明で、
 * こちらは「困っている人」の表明。コメントを書くほどではない・書けない人が
 * 意思表示できる、最も心理的コストの低い手段として置いている。
 *
 * 反応した人の一覧は出さない。「私も困っている」は生活圏の露出に
 * つながりえるため、公開するのは件数だけ（理由は `routes/reactions.ts`）。
 * `HelpOfferButton` が表明者を並べているのと対照的なのはそのため。
 *
 * 件数の初期値は Server Component 側（詳細ページ）が取得して props で渡す。
 * この画面を開いた時点の件数がサーバー側の描画に含まれるので、JS の実行前でも
 * 「何人が同じことで困っているか」は読める。押した後の更新だけをこちらで行う。
 *
 * `initialSummary` が null のときは、反応の取得そのものに失敗している。
 * Issue 本体は表示できているので、ボタンを消してその旨だけを出す。
 */
export function ReactionButton({
	issueId,
	initialSummary,
	locale = DEFAULT_LOCALE,
}: {
	issueId: string;
	initialSummary: ReactionSummary | null;
	locale?: Locale;
}) {
	const { isLoaded, isSignedIn, getToken } = useAuth();
	const messages = getUiMessages(locale);

	const [summary, setSummary] = useState(initialSummary);
	const [isSubmitting, setIsSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);

	if (!summary) {
		return <p className="text-warning">{messages.reaction.fetchFailed}</p>;
	}

	/**
	 * 反応・取り消しの後に件数を取り直す。
	 *
	 * 押した結果を手元で加減算して表示することもできるが、その間に他の人が
	 * 反応していると件数がずれる。押した直後は正しい値を見せたい場面なので、
	 * サーバーに聞き直す。
	 *
	 * 取り直しに失敗した場合は、少なくとも自分の操作の結果は反映させる
	 * （押したのに何も変わらない画面にしない）。
	 */
	const refresh = async (token: string | null, fallback: ReactionSummary) => {
		const result = await fetchReactions(issueId, { token });
		setSummary(result.ok ? result.summary : fallback);
	};

	const handleClick = async () => {
		setError(null);
		setIsSubmitting(true);

		try {
			const token = await getToken();
			const reacting = !summary.viewerReacted;

			if (reacting) {
				await react(issueId, token);
			} else {
				await withdrawReaction(issueId, token);
			}

			// 取り直しに失敗したときに使う、自分の操作だけを反映した値
			await refresh(token, {
				total: summary.total + (reacting ? 1 : -1),
				viewerReacted: reacting,
			});
		} catch (err) {
			setError(
				err instanceof ReactionError
					? err.message
					: messages.common.unexpectedError,
			);
		} finally {
			setIsSubmitting(false);
		}
	};

	return (
		<section aria-labelledby="reactions-heading">
			{/*
			  見出しは「困っている人」。「手伝います」の「解決に動く人」と
			  対にすることで、同じ画面に並ぶ 2 つのボタンの違いが言葉だけで伝わる
			*/}
			<h2 id="reactions-heading">{messages.reaction.heading}</h2>

			{/* 0 件のときは他の空の状態と同じ弱さで出す（`HelpOfferButton` と同じ） */}
			<p className={summary.total === 0 ? "text-soft" : undefined}>
				{summary.total === 0
					? messages.reaction.none
					: messages.reaction.count(summary.total)}
			</p>

			{/*
			  未ログインでもボタンの存在は見せる。何ができる場所なのか分からないまま
			  ログインを求めるより、押せるものが分かってから促す方が親切なため
			*/}
			{isLoaded && !isSignedIn ? (
				<p className="reaction-actions">
					<SignInButton mode="modal">
						<button type="button" className="button-primary">
							{messages.reaction.react}
						</button>
					</SignInButton>
					<span className="text-soft">{messages.reaction.signInHint}</span>
				</p>
			) : (
				<p className="reaction-actions">
					<button
						type="button"
						className={
							summary.viewerReacted ? "button-secondary" : "button-primary"
						}
						onClick={handleClick}
						disabled={isSubmitting || !isLoaded}
						// 押した直後に何が起きているかを読み上げにも伝える
						aria-busy={isSubmitting}
					>
						{isSubmitting
							? messages.common.submitting
							: summary.viewerReacted
								? messages.reaction.withdraw
								: messages.reaction.react}
					</button>
					{summary.viewerReacted && (
						<span className="text-soft">{messages.reaction.youReacted}</span>
					)}
				</p>
			)}

			{error && <output className="notice text-danger">{error}</output>}
		</section>
	);
}
