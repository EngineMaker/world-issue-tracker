import {
	DEFAULT_LOCALE,
	ISSUE_STATUS_LABELS,
	ISSUE_STATUS_VALUES,
	type IssueStatus,
	type Locale,
} from "@world-issue-tracker/shared";

/**
 * ライフサイクルの段階を表すピル（Issue #95、見本は #94）。
 *
 * これまでステータスは他の補助情報（スコープ・カテゴリ・日時）と同じ
 * 見た目で「/」区切りの 1 行に並んでいた。一覧を眺めたときに、
 * どの Issue がどこまで進んでいるかが読み取れない状態だった。
 *
 * 段階ごとに色を変えるが、**色だけに頼らない**。先頭の印は段階が進むほど
 * 塗りが増える（`--fill`）ので、色が見分けにくい人にも順序が伝わる。
 * この印は装飾なので `aria-hidden` にしてある。読み上げには
 * ラベルの文字列だけが読まれればよく、印まで読ませると冗長になる。
 *
 * ラベルは `packages/shared` の辞書から引く（Issue #82）。ここに写すと
 * 一覧と詳細で同じステータスが違う表記になる。
 */
export function StatusPill({
	status,
	locale = DEFAULT_LOCALE,
}: {
	status: IssueStatus;
	locale?: Locale;
}) {
	const label = ISSUE_STATUS_LABELS[locale][status];

	/*
	 * 印の塗り具合。段階の並び（`ISSUE_STATUS_VALUES`）から算出する。
	 * CSS 側に段数を書くと、段階が増えたときに片方だけ古くなる。
	 *
	 * 最初の段階（open）でも 0 にはしない。まったく塗られていない印は
	 * 「印が出ていない」のと見分けが付かないため、最小の塗りを残す。
	 */
	const index = ISSUE_STATUS_VALUES.indexOf(status);
	const fill = (index + 1) / ISSUE_STATUS_VALUES.length;

	return (
		<span className={`status-pill status-pill-${status}`}>
			<span
				className="status-pill-mark"
				aria-hidden="true"
				style={{ "--fill": fill } as React.CSSProperties}
			/>
			{label}
		</span>
	);
}
