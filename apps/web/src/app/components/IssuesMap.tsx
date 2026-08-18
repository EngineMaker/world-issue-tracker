"use client";

import {
	DEFAULT_LOCALE,
	getUiMessages,
	type Locale,
} from "@world-issue-tracker/shared";
// MapLibre が地図の上に置く部品の見た目。理由は `IssueMap.tsx` と同じ
import "maplibre-gl/dist/maplibre-gl.css";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef } from "react";
import type { PublicIssue } from "../../lib/issues";
import {
	buildIssuesMapOptions,
	type PlottedMarker,
} from "../../lib/map-options";
import { canRenderMap } from "../../lib/map-style";
import {
	buildViewQuery,
	clampMapZoom,
	fitViewToIssues,
	type MapView,
} from "../../lib/map-view";
import { createMap, type MapHandle } from "../../lib/maplibre";

/**
 * 複数の Issue を 1 枚の地図にプロットする（#113 → #118 で MapLibre へ）。
 *
 * **MapLibre GL JS で描いている理由（#118）。** PR #117 はラスタタイルを
 * `<img>` で並べる方式だったが、それは「この作業環境では依存を追加できない」
 * ために選んだ暫定だと同 PR が明記している。#115 で本番の配信元を選ぼうと
 * した結果ラスタのまま使える選択肢が無く、Protomaps（＝ベクタタイル）を
 * 自前配信する道が残った。ベクタを描くにはライブラリが要る。
 *
 * **パン・ズームが URL に載る性質を保っている理由（#118 の受け入れ条件）。**
 * MapLibre へ移るとドラッグとホイールで動かせるようになるが、それだけだと
 * 「いま見ている場所」を人に渡せない。**動かし終えたときに URL を書き換えて
 * 同期する。** 押して動かすリンク（ページ側の `map-controls`）も残してあり、
 * JS が無効でも、ポインタが使えなくても縮尺と位置を変えられる。
 *
 * URL の書き換えに `replace` を使うのは、ドラッグのたびに履歴が積まれると
 * 「戻る」が地図の微調整の履歴で埋まり、前の画面へ戻れなくなるため。
 *
 * **地図が出る前に何も見えなくならないようにしている。** 初期 HTML には
 * 地図の箱だけが出て、Issue の一覧はページ側が地図の下に別途描いている。
 * WebGL が使えない環境でも、どこに何があるかは文字で読める。
 */

export function IssuesMap({
	issues,
	tileUrlTemplate,
	attribution = null,
	view,
	locale = DEFAULT_LOCALE,
}: {
	issues: readonly PublicIssue[];
	/** タイル配信元。未設定（null）なら地図を描かない。 */
	tileUrlTemplate: string | null;
	/** 配信元が要求する帰属表示。無ければ null。 */
	attribution?: string | null;
	/**
	 * 映す範囲。省略時は渡された Issue が全部収まるよう自動で決める。
	 * ページ側は URL のパン・ズームを反映した視界を渡す。
	 */
	view?: MapView;
	locale?: Locale;
}) {
	const container = useRef<HTMLDivElement>(null);
	const map = useRef<MapHandle | null>(null);
	const router = useRouter();
	const searchParams = useSearchParams();
	const messages = getUiMessages(locale);

	// 配信元が決まっていないときは何も描かない（Issue 63 から続く判断で、
	// Issue 118 の受け入れ条件にも入っている）。適当な既定値でタイルを
	// 取りに行くと規約違反のトラフィックを出す。呼び出し側が Issue の
	// 一覧を別に出しているので、情報は失われない
	const renderable = canRenderMap(tileUrlTemplate);

	/*
	 * URL を書き換えるための入れ物。
	 *
	 * `moveend` のハンドラは地図を作るときに 1 回だけ登録するので、
	 * そこから今の `searchParams` を直接読むと**登録した時点の値**を
	 * ずっと見続ける（絞り込みを変えても、地図を動かした瞬間に
	 * 古い条件へ戻る）。ref 越しに読んで最新を見る
	 */
	const latestParams = useRef(searchParams);
	latestParams.current = searchParams;

	/*
	 * 初回に映す範囲。
	 *
	 * 依存配列に入れていないのは、URL が変わるたびに地図を作り直さない
	 * ため。`moveend` で URL を書き換えるので、依存に入れると
	 * 「動かす → URL 更新 → 作り直し → 初期位置へ戻る」の輪ができて、
	 * ドラッグした先から弾き返される
	 */
	const initialView = useRef(view ?? fitViewToIssues(issues));

	/*
	 * 地図を作り直す条件。
	 *
	 * `issues` は配列なので、ページが再描画されるたびに**中身が同じでも
	 * 別の参照**になる。そのまま依存配列に入れると、`moveend` で URL を
	 * 書き換える → Server Component が再実行される → 新しい配列が渡る →
	 * 地図が作り直されて初期位置へ戻る、という輪ができる。
	 * **ドラッグするたびに地図が跳ね返る**状態になり、操作できない。
	 *
	 * 中身から文字列を作って比べる。id と座標だけを見ているのは、
	 * 地図に効くのがそれだけだから（タイトルが変わってもマーカーの
	 * 位置は動かない）
	 */
	const issuesKey = issues
		.map((issue) => `${issue.id}:${issue.latitude}:${issue.longitude}`)
		.join(",");

	// 地図を作るときに読む Issue。上の `issuesKey` が同じなら中身も同じ
	// なので、最新の参照を ref 越しに読む（依存配列には入れない）
	const latestIssues = useRef(issues);
	latestIssues.current = issues;

	// `issuesKey` は「Issue の集合が変わったら地図を作り直す」ための鍵で、
	// 効果の中では直接読まない（中身は ref 経由で読む）。lint はこれを
	// 余分な依存と見るが、外すと**絞り込みを変えてもマーカーが古いまま**
	// になる。値そのものではなく「変わったこと」を依存にしている
	// biome-ignore lint/correctness/useExhaustiveDependencies: Issue の集合が変わったことを検知するための鍵
	useEffect(() => {
		const element = container.current;
		if (!element) return;

		// 地図の設定は `lib/map-options.ts` が組み立てる。MapLibre は WebGL を
		// 要求してテストでは描けないので、判断を含む部分を描画の外へ出して
		// 値として検査できる形にしている（`map-options.test.ts`）
		const options = buildIssuesMapOptions(
			latestIssues.current,
			initialView.current,
			tileUrlTemplate,
			attribution,
		);
		if (!options) return;

		let disposed = false;
		createMap({
			...options,
			container: element,
			// 値としてのマーカーを、押せる DOM 要素にする
			markers: options.markers.map((marker) => ({
				longitude: marker.longitude,
				latitude: marker.latitude,
				element: createMarkerElement(marker),
			})),
			// 動かし終えたら URL を合わせる。これで「いま見ている場所」が
			// そのまま共有・ブックマークできる（Issue 118 の受け入れ条件）
			onMoveEnd: (moved) => {
				const query = buildViewQuery(latestParams.current, {
					centerLatitude: moved.latitude,
					centerLongitude: moved.longitude,
					zoom: clampMapZoom(moved.zoom),
				});
				router.replace(`/map?${query}`, { scroll: false });
			},
		}).then((handle) => {
			if (disposed) {
				handle?.remove();
				return;
			}
			map.current = handle;
		});

		return () => {
			disposed = true;
			map.current?.remove();
			map.current = null;
		};
	}, [tileUrlTemplate, attribution, issuesKey, router]);

	if (!renderable) {
		return null;
	}

	return (
		<figure className="issues-map">
			{/*
			  表示領域の寸法は CSS に置いている（`.issues-map-view`）。
			  MapLibre は箱の大きさに合わせて描くので、tsx 側は寸法を持たない
			  （#113 の頃は tsx が px を算出していたため両方に寸法があった）
			*/}
			<div className="issues-map-view" ref={container} />

			{/*
			  地図に何件載っているかを添える。MapLibre 自身も帰属表示を
			  地図の隅に出すが、地図が読み込めなかったときに消えてしまうので
			  こちらにも置く（配信元の利用条件）
			*/}
			<figcaption className="issues-map-attribution">
				{messages.mapPage.plotted(issues.length)}
				{attribution ? (
					<>
						{" — "}
						{/*
						  配信元が要求する文言はリンクを含むため HTML として描く。
						  素の文字列にするとタグが画面に見えてしまい、利用条件が
						  求めるリンクにもならない。値の出所は環境変数
						  `NEXT_PUBLIC_MAP_TILE_ATTRIBUTION` で、利用者の入力は
						  混ざらない（件数の側は React が描くまま変えない）
						*/}
						<span
							// biome-ignore lint/security/noDangerouslySetInnerHtml: 配信元の帰属表示は環境変数由来で、利用者の入力を含まない
							dangerouslySetInnerHTML={{ __html: attribution }}
						/>
					</>
				) : null}
			</figcaption>
		</figure>
	);
}

/**
 * マーカーとして置く DOM 要素を作る。
 *
 * MapLibre の既定のピンではなくリンクにしているのは、点が光るだけでは
 * 「何が起きているか」まで辿れないため（#113 から続く形）。
 *
 * React の外で組み立てているのは、MapLibre の `Marker` が DOM 要素を
 * 直接受け取る API だから。ここで `document` を触るが、この部品は
 * `use client` かつ `useEffect` の中からしか呼ばれないので、
 * サーバー側の描画では実行されない。
 */
function createMarkerElement(marker: PlottedMarker): HTMLAnchorElement {
	const link = document.createElement("a");
	link.className = "issues-map-marker";
	link.href = `/issues/${marker.id}`;

	// マーカーは見た目としては点だが、読み上げには何の Issue かが要る。
	// 視覚的には隠して文字だけ残す（`textContent` に入れるので、
	// タイトルに HTML が含まれていても要素として解釈されない）
	const label = document.createElement("span");
	label.className = "visually-hidden";
	label.textContent = marker.label;
	link.append(label);

	return link;
}
